#!/usr/bin/env node
// Consensus Brain: a live terminal view of the Consensus Harness state, meant for a pane beside Claude Code.
// Reads ~/.consensus-harness/{projects,sessions}/*.json. Writes only when you act on an item (a/o/x), and then
// through the plugin's own state script, so the same rules apply as when Claude writes. No dependencies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = process.env.CONSENSUS_HOME || path.join(os.homedir(), '.consensus-harness');
const HOME = os.homedir();
// Terminal background (asked via OSC 11 at start, or --bg RRGGBB). Dim colours blend toward it.
let BG = [0, 0, 0];
const STATE_CLI = process.env.CONSENSUS_STATE_CLI || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'consensus-claude-plugin', 'scripts', 'state.mjs');
const USAGE = `consensus-brain: live view of the Consensus Harness state

Usage: node brain.mjs [--project <dir>] [--no-mesh] [--once [--size WxH]]

  (default)        follow the most recently changed consensus (any project or session)
  --project <dir>  pin to the consensus of one project folder
  --no-mesh        hide the background neural mesh
  --once           print one frame and exit (for testing); --size sets its size

Keys: ↑↓ select an item, then a agree · o open · x remove (twice)
      tab next consensus · p pin/follow · m mesh · ? what the colours mean · q quit`;

const opt = {project: null, mesh: true, once: false, size: [100, 36], help: false, select: 0};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--project' || a === '-p') opt.project = path.resolve(argv[++i] || '.');
  else if (a === '--no-mesh') opt.mesh = false;
  else if (a === '--bg') { opt.bgSet = true; const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(argv[++i] || ''); if (m) BG = [1, 2, 3].map(j => parseInt(m[j], 16)); }
  else if (a === '--once') opt.once = true;
  else if (a === '--topic') opt.topic = argv[++i] || ''; // --once tests: open this topic
  else if (a === '--offset') opt.offset = +argv[++i] || 0; // --once tests: start further back
  else if (a === '--select') opt.select = +argv[++i] || 0; // --once tests: preselect the n-th item
  else if (a === '--show-help') opt.help = true; // start with the ? overlay open (also for --once tests)
  else if (a === '--size') { const m = /^(\d+)x(\d+)$/.exec(argv[++i] || ''); if (m) opt.size = [+m[1], +m[2]]; }
  else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
  else { console.error(`Unknown option ${a}\n\n${USAGE}`); process.exit(1); }
}

// ---------- palette ----------
const C = {
  agreed: [94, 234, 212], open: [251, 191, 36], assumed: [196, 181, 253], rejected: [244, 114, 140],
  goal: [241, 245, 249], mesh: [90, 108, 150], spark: [186, 230, 253], ghost: [150, 150, 160],
  text: [203, 213, 225], dim: [100, 116, 139], off: [120, 120, 130],
};
const GLYPH = {agreed: '●', open: '◆', assumed: '○', rejected: '✕'};
const RANK = {agreed: 0, open: 1, assumed: 2, rejected: 3};
const FRESH_MS = 6000;   // bright arrival phase
const ATTN_MS = 20000;   // '✦ new' tag and pulse

// ---------- small helpers ----------
function hash(s) { let h = 2166136261; for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; }
function rng(seed) { let x = (Math.floor(seed * 4294967296) >>> 0) || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeOut = p => 1 - Math.pow(1 - p, 3);
const mix = (a, b, p) => [a[0] + (b[0] - a[0]) * p, a[1] + (b[1] - a[1]) * p, a[2] + (b[2] - a[2]) * p];
function truncate(s, n) { const cp = [...s]; return cp.length <= n ? s : cp.slice(0, Math.max(0, n - 1)).join('') + '…'; }
function wrap(text, width) {
  const out = []; let line = '';
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while ([...word].length > width) { if (line) { out.push(line); line = ''; } out.push([...word].slice(0, width).join('')); word = [...word].slice(width).join(''); }
    if (!line) line = word; else if ([...line].length + 1 + [...word].length <= width) line += ' ' + word; else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}
function fmtAge(ms) { const s = Math.max(0, Math.round(ms / 1000)); if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.round(s / 60)}m ago`; if (s < 86400) return `${Math.round(s / 3600)}h ago`; return `${Math.round(s / 86400)}d ago`; }

// ---------- reading state ----------
function listStates() {
  const out = [];
  for (const sub of ['projects', 'sessions']) {
    const dir = path.join(ROOT, sub);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const file = path.join(dir, n);
      try {
        const st = JSON.parse(fs.readFileSync(file, 'utf8'));
        // a folder state already imported into long-term memory is history, not a live consensus
        if (sub === 'projects' && st.migrated) continue;
        let mtime = fs.statSync(file).mtimeMs;
        // a session you are talking to counts as recent too (the activity hook writes on every prompt and tool call)
        if (st.session) { try { mtime = Math.max(mtime, fs.statSync(path.join(ROOT, 'activity', `${String(st.session).replace(/[^\w-]/g, '_')}.json`)).mtimeMs); } catch {} }
        out.push({file, mtime});
      } catch {}
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
function readJSON(file) { try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(s.items) ? s : null; } catch { return null; } }

const model = {file: null, mtime: 0, state: null, nodes: new Map(), goal: '', goalChanged: -1e12, pinned: !!opt.project, first: true,
  sel: null, order: [], needs: [], confirmX: 0, msg: null, offset: 0, pages: [], pageCount: 0, input: null, openSeg: null, segManual: false, segNames: []};

function pickFile() {
  const all = listStates();
  if (opt.project && !model.file) {
    for (const s of all) { const st = readJSON(s.file); if (st && path.resolve(st.project || '') === opt.project) return s; }
    return null;
  }
  if ((model.pinned || model.sel) && model.file) return all.find(s => s.file === model.file) || null; // don't jump away mid-selection
  return all[0] || null;
}
function load(pick, now) {
  if (!pick) { model.file = null; model.state = null; model.nodes.clear(); return; }
  if (pick.file === model.file && pick.mtime === model.mtime) return;
  const st = readJSON(pick.file);
  if (!st) return; // mid-write or corrupt: keep the last good frame
  if (pick.file !== model.file) { model.nodes.clear(); model.first = true; model.goal = ''; model.offset = 0; model.pages = []; model.sel = null; }
  model.file = pick.file; model.mtime = pick.mtime; model.state = st;
  const seen = new Set();
  st.items.forEach((it, i) => {
    seen.add(it.id);
    const status = it.status in RANK ? it.status : 'assumed';
    const text = String(it.text || '');
    let n = model.nodes.get(it.id);
    if (!n) {
      // first load: everything at once; only real arrivals animate in
      n = {id: it.id, seed: hash(it.id), a: null, born: model.first ? now - 1000 : now, changed: -1e12, removed: null, arrived: model.first ? -1e12 : now};
      if (!model.first) model.arrival = now;
      model.nodes.set(it.id, n);
    } else if (n.status !== status || n.text !== text || n.removed !== null || (it.notes || []).length !== (n.notes || []).length) { n.changed = now; model.arrival = now; }
    Object.assign(n, {status, text, order: i, removed: null, time: Number(it.updated || it.at) || 0, notes: Array.isArray(it.notes) ? it.notes : [], topic: String(it.topic || '').trim()});
  });
  for (const n of model.nodes.values()) if (!seen.has(n.id) && n.removed === null) n.removed = now;
  const goal = String(st.goal || '');
  if (goal !== model.goal && !model.first) model.goalChanged = now;
  model.goal = goal; model.first = false;
}
// A session state (home folder) takes its on/off switch from the folder's own state, like the plugin does.
function folderEnabled(st) {
  for (const s of listStates()) {
    const f = readJSON(s.file);
    if (f && !f.session && path.resolve(f.project || '/') === path.resolve(st.project || '/')) return f.enabled !== false;
  }
  return true;
}
// Live activity, written by the plugin's activity hook: thinking / working on X / waiting / idle (your turn).
function readActivity(st) {
  if (!st?.session) return null;
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'activity', `${String(st.session).replace(/[^\w-]/g, '_')}.json`), 'utf8')); } catch { return null; }
}
const poll = now => { load(pickFile(), now); if (model.state?.session) model.state.enabled = folderEnabled(model.state); model.act = readActivity(model.state); };

// ---------- screen: text overlay on top of a braille pixel canvas ----------
class Screen {
  constructor(W, H) {
    Object.assign(this, {W, H, gy: 0, gh: 0});
    const n = W * H;
    this.ch = new Array(n).fill(' '); this.fg = new Array(n).fill(null); this.bold = new Uint8Array(n); this.occ = new Uint8Array(n);
    this.bits = new Uint8Array(n); this.bc = new Float32Array(n * 3);
  }
  text(x, y, s, col, bold = false) {
    if (y < 0 || y >= this.H) return;
    let i = 0;
    for (const c of s) { const xx = x + i++; if (xx < 0 || xx >= this.W) continue; const k = y * this.W + xx; this.ch[k] = c; this.fg[k] = col; this.bold[k] = bold ? 1 : 0; this.occ[k] = 1; }
  }
  free(x, y, len) {
    if (y < this.gy || y >= this.gy + this.gh || x < 0 || x + len > this.W) return false;
    for (let i = 0; i < len; i++) if (this.occ[y * this.W + x + i]) return false;
    return true;
  }
  dot(px, py, col, k) {
    px = Math.round(px); py = Math.round(py);
    if (k <= 0.01 || px < 0 || py < 0 || px >= this.W * 2 || py >= this.gh * 4) return;
    const i = (this.gy + (py >> 2)) * this.W + (px >> 1), dx = px & 1, dy = py & 3;
    this.bits[i] |= dy === 3 ? (dx ? 0x80 : 0x40) : 1 << (dy + dx * 3);
    for (let c = 0; c < 3; c++) this.bc[i * 3 + c] = Math.max(this.bc[i * 3 + c], col[c] * k);
  }
  line(x0, y0, x1, y1, col, k, every = 1) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let s = 0; s <= n; s += every) this.dot(x0 + (x1 - x0) * s / n, y0 + (y1 - y0) * s / n, col, k);
  }
  ring(x, y, r, col, k, every = 1) {
    const n = Math.max(8, Math.ceil(2 * Math.PI * r));
    for (let s = 0; s < n; s += every) this.dot(x + Math.cos(s / n * 2 * Math.PI) * r, y + Math.sin(s / n * 2 * Math.PI) * r, col, k);
  }
  render(color, rowPrefix) {
    const rows = [];
    for (let y = 0; y < this.H; y++) {
      let line = rowPrefix ? rowPrefix(y) : '', last = '';
      for (let x = 0; x < this.W; x++) {
        const i = y * this.W + x;
        let c, col, b = 0;
        if (this.occ[i] || !this.bits[i]) { c = this.ch[i]; col = this.fg[i]; b = this.bold[i]; }
        else { c = String.fromCharCode(0x2800 + this.bits[i]); col = [this.bc[i * 3], this.bc[i * 3 + 1], this.bc[i * 3 + 2]]; }
        if (color) {
          const lift = (v, i) => (BG[i] + v * (255 - BG[i]) / 255) | 0; // dim colours fade into the background
          const code = col ? `\x1b[${b ? 1 : 22};38;2;${lift(col[0], 0)};${lift(col[1], 1)};${lift(col[2], 2)}m` : '\x1b[0m';
          if (code !== last) { line += code; last = code; }
        }
        line += c;
      }
      rows.push(color ? line + '\x1b[0m' : line.trimEnd());
    }
    return rows;
  }
}

// ---------- background: a cortex-shaped network filling the whole graph ----------
let mesh = null;
function getMesh(PW, PH) {
  const key = `${PW}x${PH}`;
  if (mesh && mesh.key === key) return mesh;
  // Points fill two overlapping hemispheres across the full width, denser towards the rim, with a faint fissure.
  const r = rng(0.4242), cx = PW / 2, cy = PH / 2, hx = PW * 0.31, hy = PH * 0.48, off = PW * 0.2;
  const count = clamp(Math.round(PW * PH / 150), 24, 220), pts = [];
  let guard = 0;
  while (pts.length < count && guard++ < 20000) {
    const side = r() < 0.5 ? -1 : 1, a = r() * 2 * Math.PI, rad = Math.sqrt(0.15 + 0.85 * r()) ** 0.6;
    const x = cx + side * off * 0.5 + Math.cos(a) * hx * rad, y = cy + Math.sin(a) * hy * rad * (Math.sin(a) > 0 ? 0.92 : 1);
    if (x < 1 || x > PW - 2 || y < 1 || y > PH - 2 || Math.abs(x - cx) < 2) continue;
    pts.push({x, y, ph: r() * 6.28, sp: 0.6 + r() * 1.4});
  }
  const links = [];
  pts.forEach((p, i) => {
    pts.map((q, j) => [j, Math.hypot(p.x - q.x, p.y - q.y)]).filter(([j]) => j !== i).sort((a, b) => a[1] - b[1]).slice(0, 3)
      .forEach(([j, d]) => { if (d < Math.max(PW, PH) * 0.12 && !links.some(l => l[0] === j && l[1] === i)) links.push([i, j]); });
  });
  mesh = {key, pts, links, sparks: [], nextSpark: 0};
  return mesh;
}

// ---------- ? overlay: what the colours and effects mean ----------
const HELP = [ // what each status means for you and Claude, not how it is drawn
  ['●', C.agreed, 'agreed', 'You confirmed it. Claude follows it and asks before going against it.'],
  ['◆', C.open, 'open', 'Still to be decided. Neither of you should treat it as settled.'],
  ['○', C.assumed, 'assumed', "Claude's own interpretation, not confirmed by you. Agree it, or correct Claude."],
  ['◉', C.goal, 'goal', 'What the work is for. ◌ means no goal is agreed yet.'],
  ['✕', C.rejected, 'rejected', "You said no. Claude won't act on it or propose it again."],
  ['●', C.spark, 'bright', 'New or just changed.'],
  ['·', C.ghost, 'fading', 'Just removed: forgotten, as if it was never there.'],
  ['●', C.off, 'all grey', "Harness is off. Claude isn't using the consensus."],
];
// The four things a new user needs, shown first in the ? overlay.
const HOWTO = [
  'Talk with Claude as usual. Decisions land here, by topic.',
  "○ ◆ wait for you (⚑). ↵ jumps there: a agree, d disagree, n note.",
  '● agreed is what Claude works from. ◆ open is undecided.',
  'Your changes here reach Claude with your next message.',
];
function drawHelp(S, W, H) {
  const boxW = Math.min(W - 2, 76), wide = boxW >= 56, nameW = 11;
  const descW = wide ? boxW - nameW - 6 : boxW - 8;
  const rows = []; // {g, col, name, text, kind}
  rows.push({kind: 'head', text: 'how it works'});
  HOWTO.forEach((h, i) => wrap(h, boxW - 8).forEach((l, j) => rows.push({kind: 'step', n: j ? '' : String(i + 1), text: l})));
  rows.push({kind: 'plain', text: ''}, {kind: 'head', text: 'what it means'});
  for (const [g, col, name, desc] of HELP) {
    if (wide) wrap(desc, descW).forEach((l, i) => rows.push(i ? {kind: 'item', text: l} : {kind: 'item', g, col, name, text: l}));
    else { rows.push({kind: 'item', g, col, name, text: ''}); wrap(desc, descW).forEach(l => rows.push({kind: 'item', text: l})); }
  }
  rows.push({kind: 'plain', text: ''});
  for (const l of wrap('↵ next that needs you · ↑↓ select, then a agree · d disagree · o open · n note · x x forget it · ←→ topic · pgup/pgdn page · g newest topic · tab next consensus · p pin · m mesh · ? / esc close · q quit', boxW - 4)) rows.push({kind: 'plain', text: l});
  const boxH = Math.min(H - 2, rows.length + 3), x0 = Math.max(0, Math.floor((W - boxW) / 2)), y0 = Math.max(0, Math.floor((H - boxH) / 2));
  const border = C.dim, blank = ' '.repeat(Math.max(0, boxW - 2));
  S.text(x0, y0, '╭' + '─'.repeat(boxW - 2) + '╮', border);
  for (let r = 1; r < boxH - 1; r++) S.text(x0, y0 + r, '│' + blank + '│', border);
  S.text(x0, y0 + boxH - 1, '╰' + '─'.repeat(boxW - 2) + '╯', border);
  const room = boxH - 3;
  rows.slice(0, room).forEach((row, i) => {
    const y = y0 + 1 + i;
    if (i === room - 1 && rows.length > room) { S.text(x0 + 2, y, truncate('… enlarge the pane for more', boxW - 4), C.dim); return; }
    if (row.kind === 'head') S.text(x0 + 2, y, row.text, C.goal, true);
    else if (row.kind === 'step') { if (row.n) S.text(x0 + 3, y, row.n, C.agreed, true); S.text(x0 + 6, y, row.text, C.text); }
    else if (row.kind === 'plain') S.text(x0 + 2, y, row.text, C.dim);
    else {
      if (row.g) S.text(x0 + 2, y, row.g, row.col, true);
      if (row.name) S.text(x0 + 4, y, row.name, row.col, true);
      if (row.text) S.text(x0 + (wide ? 4 + nameW : 6), y, row.text, C.text);
    }
  });
}

// ---------- one frame ----------
function frame(now, W, H, color = true, rowPrefix = null) {
  const t = now / 1000, S = new Screen(W, H), st = model.state, off = !!st && st.enabled === false;
  const act = st && !off ? model.act : null, fresh10 = act && Date.now() - act.at < 600000;
  const busy = !!(fresh10 && (act.state === 'working' || act.state === 'thinking')), waitingP = !!(fresh10 && act.state === 'waiting');
  const tone = (col, k = 1) => { const c = off ? mix(col, C.off, 0.75) : col; const kk = off ? k * 0.6 : k; return [c[0] * kk, c[1] * kk, c[2] * kk]; };
  const glow = (col, k) => off ? k * 0.6 : k;

  // nodes in display order: agreed, open, assumed; ghosts (removed) fade where they were
  for (const n of [...model.nodes.values()]) if (n.removed !== null && now - n.removed > 1600) model.nodes.delete(n.id);
  // newest first: last created or changed (timestamps from the state script), else creation order
  const alive = [...model.nodes.values()].filter(n => n.removed === null).sort((a, b) => (b.time - a.time) || (b.order - a.order));
  const ghosts = [...model.nodes.values()].filter(n => n.removed !== null);
  alive.forEach((n, i) => { n.idx = i + 1; n.rank = i; });
  // focus: the two newest items at full strength, older ones fade step by step
  const focus = n => n.removed !== null || !(n.rank > 1) ? 1 : Math.max(0.4, 1 - (n.rank - 1) * 0.09);
  const counts = {agreed: 0, open: 0, assumed: 0, rejected: 0};
  alive.forEach(n => counts[n.status]++);
  // attention: only real arrivals and changes, never the initial load
  const attnT = n => Math.max(n.arrived ?? -1e12, n.changed);
  const fresh = n => now - attnT(n) < FRESH_MS;
  const recent = n => now - attnT(n) < ATTN_MS;

  // header
  let y = 0;
  const name = !st ? 'no consensus yet' : (path.resolve(st.project || '/') === HOME ? '~' : path.basename(st.project || '/')) + (st.session ? ` · session ${String(st.session).slice(0, 8)}` : '');
  const age = st ? fmtAge(Date.now() - model.mtime) : '';
  const tail = (off ? 'OFF' : '') + (off && W >= 44 ? '  ' : '') + (W >= 44 ? age : '');
  const named = W >= 60; // legend: wide panes name each colour, narrow ones show only the symbols
  const parts = [[`● ${counts.agreed}${named ? ' agreed' : ''}`, C.agreed], [`◆ ${counts.open}${named ? ' open' : ''}`, C.open], [`○ ${counts.assumed}${named ? ' assumed' : ''}`, C.assumed]];
  if (counts.rejected) parts.push([`✕ ${counts.rejected}${named ? ' rejected' : ''}`, C.rejected]);
  // needs you: assumptions and open questions waiting for the user's answer, newest first
  const needs = alive.filter(n => n.status === 'assumed' || n.status === 'open');
  model.needs = needs.map(n => n.id);
  if (st) parts.unshift(needs.length
    ? [`⚑ ${needs.length}${named ? ' need you' : ''}`, mix(C.open, C.goal, 0.25 + 0.25 * Math.sin(t * 3))]
    : [named ? '✓ all clear' : '✓', mix(C.agreed, C.dim, 0.5)]);
  const rightLen = parts.reduce((a, [s]) => a + [...s].length + 2, 0) + (tail ? [...tail].length + 1 : 0);
  let rx0 = W - rightLen;
  for (const [txt, col] of parts) { S.text(rx0, y, txt, tone(col), true); rx0 += [...txt].length + 2; }
  if (tail) S.text(rx0 + 1, y, tail, off ? C.ghost : tone(C.dim));
  const avail = W - rightLen - 2;
  if (avail >= 12) {
    S.text(1, y, '◉ CONSENSUS', tone(C.goal), true);
    if (avail - 14 >= 4) S.text(14, y, truncate(name, avail - 14), tone(C.dim));
  } else if (avail >= 2) S.text(1, y, '◉', tone(C.goal), true);
  y++;
  const goalFresh = now - model.goalChanged < FRESH_MS;
  const goalLines = model.goal ? wrap(model.goal, W - 8).slice(0, 2) : ['not agreed yet'];
  goalLines.forEach((l, i) => {
    if (i === 0) S.text(1, y, 'goal', tone(C.dim));
    S.text(7, y, i === 1 && wrap(model.goal, W - 8).length > 2 ? truncate(l + ' …', W - 8) : l, model.goal ? tone(goalFresh ? C.spark : C.goal) : tone(C.dim), !!model.goal);
    y++;
  });
  // what Claude is doing right now (from the plugin's activity hook)
  if (act && W >= 30) {
    const spin = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[Math.floor(t * 10) % 10], pulse = 0.5 + 0.5 * Math.sin(t * 3);
    const [icon, col, text] = waitingP ? ['⚠', mix(C.open, C.goal, 0.3 * pulse), act.label]
      : busy ? [spin, C.spark, `Claude · ${act.label}`]
      : act.state === 'idle' ? ['◉', mix(C.agreed, C.goal, 0.3 * pulse), model.needs.length ? `your turn · ⚑ ${model.needs.length} need you, press enter` : 'your turn']
      : ['·', C.dim, act.state === 'ended' ? 'session ended' : 'idle'];
    S.text(1, y, icon, tone(col), true); S.text(3, y, truncate(text, W - 5), tone(col), busy || waitingP || act.state === 'idle'); y++;
  }
  S.text(0, y++, '─'.repeat(W), tone(C.dim, 0.5));

  // footer
  const hintRow = H - 1;
  const hint = model.sel
    ? (W >= 84 ? 'a agree · d disagree · o open · n note · x forget · esc done' : W >= 40 ? 'a · d · o · n · x · esc' : 'esc')
    : model.needs.length
      ? (W >= 80 ? '↵ next that needs you · ↑↓ select · ←→ topic · ? help' : W >= 40 ? '↵ next · ↑↓ · ←→ · ? help' : '↵ next')
      : (W >= 72 ? 'q quit · ↑↓ select · ←→ topic · ? help' : W >= 40 ? 'q · ↑↓ · ←→ · ? help' : '? help');
  if (model.input) {
    const label = model.input.label || 'note: ', room = Math.max(4, W - label.length - 4), txt = [...model.input.text];
    S.text(1, hintRow, label, C.open, true);
    S.text(1 + label.length, hintRow, (txt.length > room ? '…' + txt.slice(-room + 1).join('') : model.input.text) + '▌', C.goal, true);
  }
  else if (model.msg && Date.now() < model.msg.until) S.text(1, hintRow, truncate(model.msg.text, W - 20), model.msg.col, true);
  else if (model.sel && model.nodes.get(model.sel) && W >= 40) {
    const st2 = model.nodes.get(model.sel).status, tag = `${GLYPH[st2]} ${st2} · `;
    S.text(1, hintRow, tag, C[st2], true);
    S.text(1 + [...tag].length, hintRow, truncate(hint, W - 2 - [...tag].length), C.goal, true);
  }
  else S.text(1, hintRow, hint, model.sel ? C.goal : tone(C.dim, 0.7), !!model.sel);
  const mode = model.input ? 'enter save · esc cancel' : model.segManual ? 'g newest topic' : model.pinned ? 'pinned' : W >= 56 ? 'following newest' : 'follow';
  if (!model.input || W >= 60) S.text(W - mode.length - 1, hintRow, mode, tone(model.input ? C.open : model.pinned ? C.open : C.dim, 0.8));
  S.gy = y; S.gh = Math.max(0, hintRow - y);
  if (S.gh < 3) return S.render(color, rowPrefix);

  // ---- layout: topics. The open topic's items in full on the right; every topic as one line on the left ----
  // Narrow panes show only the open topic, with its name and ←→ in a title row.
  const two = W >= 64;
  // Columns are capped so text stays readable on very wide panes; the whole composition is centred.
  const band = two ? clamp(Math.floor(W * 0.2), 12, 26) : clamp(Math.floor(W * 0.24), 8, 16);
  const leftW = two ? Math.min(34, Math.floor((W - band - 2) * 0.4)) : 0;
  const colW = two ? Math.min(66, W - band - 2 - leftW) : Math.min(70, W - band - 1);
  const x0 = Math.max(0, Math.floor((W - (leftW + band + colW)) / 2)); // left margin of the composition
  const ltw = Math.max(6, leftW - 3), tw = Math.max(8, colW - 3);     // text widths: topic list, items
  const lx = x0 + 1;                                                    // topic list text starts here
  const nodeCol = {left: lx + ltw + 1, right: x0 + leftW + band};
  const PW = W * 2, PH = S.gh * 4, cy = PH / 2;
  const cx = two ? (x0 + leftW + band / 2) * 2 : nodeCol.right; // goal neuron (pixels)
  // topics, newest first (a topic is as recent as its newest item)
  const segMap = new Map();
  for (const n of alive) { const k = n.topic || 'General'; if (!segMap.has(k)) segMap.set(k, []); segMap.get(k).push(n); }
  const segs = [...segMap].map(([name, list]) => ({name, list, time: Math.max(...list.map(n => n.time)), order: Math.max(...list.map(n => n.order))}))
    .sort((a, b) => (b.time - a.time) || (b.order - a.order));
  model.segNames = segs.map(sg => sg.name);
  if (model.openSeg && !segMap.has(model.openSeg)) model.segManual = false;
  if (!model.segManual) model.openSeg = segs.length ? segs[0].name : null; // follow the newest topic unless you picked one
  const open = segs.find(sg => sg.name === model.openSeg) || null;
  const items = open ? open.list : [];
  items.forEach((n, i) => { n.rank = i; });
  for (const n of alive) n.cell = null;
  const hub = two ? [cx + (nodeCol.right * 2 - cx) * 0.4, cy] : [cx, cy]; // the open topic's hub, between goal and items

  // right column: title row, then the open topic's items (pages if they don't fit)
  const top = S.gy + 2, rowsAvail = Math.max(1, S.gh - 3);
  const pack = start => {
    let used = 0; const out = [];
    for (let i = start; i < items.length; i++) {
      const n = items[i], textLines = wrap(n.text, tw);
      const lines = textLines.concat(...n.notes.map(nt => wrap('↳ ' + nt.text, tw)));
      n.textLines = textLines.length;
      const gap = used ? 1 : 0;
      if (used + gap + lines.length > rowsAvail) { if (!out.length) out.push({n, lines: lines.slice(0, rowsAvail), row: 0}); break; }
      out.push({n, lines, row: used + gap}); used += gap + lines.length;
    }
    return {out, h: used};
  };
  model.offset = clamp(model.offset, 0, Math.max(0, items.length - 1));
  const selIdx = model.sel ? items.findIndex(n => n.id === model.sel) : -1;
  if (selIdx >= 0 && selIdx < model.offset) { model.offset = selIdx; model.pages = []; }
  let page = pack(model.offset);
  while (selIdx >= model.offset + page.out.length && model.offset < selIdx) { model.offset++; model.pages = []; page = pack(model.offset); }
  model.pageCount = page.out.length;
  const base = top + Math.floor((rowsAvail - page.h) / 2);
  const titleRow = Math.max(S.gy, base - 2);
  for (const {n, lines, row} of page.out) {
    n.cell = {side: 'right', c: nodeCol.right, r: base + row};
    n.lines = lines;
    n.last = [nodeCol.right * 2 + 1, (base + row - S.gy) * 4 + 2];
  }
  const newer = model.offset, older = items.length - model.offset - page.out.length;
  if (newer) S.text(nodeCol.right + 2, Math.max(S.gy, base - 1), `↑ ${newer} newer  pgup`, tone(C.spark, 0.9), true);
  if (older > 0) S.text(nodeCol.right + 2, Math.min(S.gy + S.gh - 1, base + page.h + 1), `↓ ${older} older  pgdn`, tone(C.spark, 0.9), true);
  if (open) {
    const idx = segs.indexOf(open), nav = segs.length > 1 ? `  ${idx + 1}/${segs.length} ←→` : '';
    const name = truncate(open.name, Math.max(4, colW - 3 - nav.length));
    S.text(nodeCol.right, titleRow, '◈', C.goal, true);
    S.text(nodeCol.right + 2, titleRow, name, C.goal, true);
    if (nav) S.text(nodeCol.right + 2 + [...name].length, titleRow, nav, tone(C.dim));
  }

  // left column: every topic as one line (name + counts), wired to the goal
  const segRows = [];
  if (two && segs.length) {
    let gapT = segs.length > 1 ? clamp(Math.floor((S.gh - segs.length) / (segs.length - 1)), 0, 2) : 0;
    let showN = segs.length;
    if (showN + (showN - 1) * gapT > S.gh) { gapT = 0; showN = Math.max(1, Math.min(segs.length, S.gh - 1)); }
    const openIdx = Math.max(0, segs.indexOf(open)), start = Math.max(0, openIdx - showN + 1);
    let row = S.gy + Math.floor((S.gh - (showN + (showN - 1) * gapT)) / 2);
    segs.slice(start, start + showN).forEach((sg, i) => { segRows.push({sg, r: row, i: start + i}); row += 1 + gapT; });
    if (start + showN < segs.length) S.text(lx, Math.min(S.gy + S.gh - 1, row), `+${segs.length - start - showN} older topics  →`, tone(C.dim));
    if (start > 0) S.text(lx, S.gy, `+${start} newer topics  ←`, tone(C.dim));
  }

  if (opt.mesh) {
    const M = getMesh(PW, PH);
    for (const [i, j] of M.links) {
      const p = M.pts[i], q = M.pts[j];
      S.line(p.x, p.y, q.x, q.y, tone(C.mesh), glow(0, 0.27 + 0.08 * Math.sin(t * p.sp + p.ph)), 2);
    }
    const wt = now - (model.arrival || -1e12), waving = wt < 1600 && !off;
    const maxD = Math.hypot(PW, PH) / 2, waveR = (wt / 1600) * maxD;
    for (const p of M.pts) {
      S.dot(p.x, p.y, tone(C.mesh), glow(0, 0.65 + 0.3 * Math.sin(t * p.sp * 1.7 + p.ph)));
      if (waving) { const b = Math.exp(-((Math.hypot(p.x - cx, p.y - cy) - waveR) ** 2) / (2 * 14 ** 2)); if (b > 0.05) { S.dot(p.x, p.y, C.spark, b); S.dot(p.x + 1, p.y, C.spark, b * 0.7); } }
    }
    if (now > M.nextSpark && M.links.length && !off) { M.sparks.push({l: M.links[Math.floor(Math.random() * M.links.length)], s: now}); M.nextSpark = now + (waving ? 20 : busy ? 35 : waitingP ? 120 : 400 + Math.random() * 800); }
    M.sparks = M.sparks.filter(sp => now - sp.s < 900);
    for (const sp of M.sparks) {
      const p = M.pts[sp.l[0]], q = M.pts[sp.l[1]], u = (now - sp.s) / 900;
      for (let k = 0; k < 4; k++) { const v = u - k * 0.04; if (v >= 0) S.dot(p.x + (q.x - p.x) * v, p.y + (q.y - p.y) * v, C.spark, 0.7 - k * 0.15); }
    }
  }

  const curve = (x0, y0, x1, y1, seed) => {
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, len = Math.hypot(x1 - x0, y1 - y0) || 1;
    const bend = (seed - 0.5) * 0.4 * len, qx = mx - (y1 - y0) / len * bend, qy = my + (x1 - x0) / len * bend;
    return u => [(1 - u) * (1 - u) * x0 + 2 * (1 - u) * u * qx + u * u * x1, (1 - u) * (1 - u) * y0 + 2 * (1 - u) * u * qy + u * u * y1];
  };
  // topic synapses: goal -> each topic node on the left; the open topic also fires into its hub
  for (const {sg, r, i} of segRows) {
    const x = nodeCol.left * 2 + 1, yy = (r - S.gy) * 4 + 2, isOpen = sg === open, sd = hash(sg.name);
    const f = curve(cx, cy, x, yy, sd), steps = Math.max(4, Math.ceil(Math.hypot(x - cx, yy - cy) / 1.1));
    const k = isOpen ? 0.6 : Math.max(0.22, 0.42 - i * 0.04);
    for (let s2 = 0; s2 <= steps; s2 += isOpen ? 1 : 2) { const [px, py] = f(s2 / steps); S.dot(px, py, tone(isOpen ? C.goal : C.text), glow(0, k)); }
  }
  if (open && two) {
    S.line(cx, cy, hub[0], hub[1], tone(C.goal), glow(0, 0.6));
    S.line(cx, cy + 1, hub[0], hub[1] + 1, tone(C.goal), glow(0, 0.4));
    for (let rr = 1; rr <= 2; rr++) S.ring(hub[0], hub[1], rr, tone(C.goal), glow(0, 0.7));
    const p = (t / (busy ? 0.6 : 1.6)) % 1; if (!off) for (let k = 0; k < 4; k++) { const u = p - k * 0.04; if (u >= 0) S.dot(cx + (hub[0] - cx) * u, cy + (hub[1] - cy) * u, C.spark, 0.9 - k * 0.2); }
  }
  const placed = alive.filter(n => n.cell && now >= n.born);
  model.order = items.map(n => n.id);
  if (model.sel && !model.order.includes(model.sel)) model.sel = null;
  // lobe links between neighbours of the same status in the same column
  for (let i = 1; i < placed.length; i++) {
    const a = placed[i - 1], b = placed[i];
    if (a.status === b.status && a.cell.side === b.cell.side) S.line(...a.last, ...b.last, tone(C[a.status]), glow(0, 0.18), 2);
  }
  // synapses: goal <-> item; a new item's synapse grows out of the goal
  for (const n of [...placed, ...ghosts.filter(g => g.last)]) {
    const [x, yy] = n.last;
    const [sx, sy] = n.removed !== null ? [cx, cy] : hub;
    const f = curve(sx, sy, x, yy, n.seed), len = Math.hypot(x - sx, yy - sy);
    const steps = Math.max(4, Math.ceil(len / 1.1));
    const grow = n.removed !== null ? 1 : easeOut(clamp((now - n.born) / 700, 0, 1));
    const ghostK = n.removed !== null ? 1 - (now - n.removed) / 1600 : 1;
    const col = n.removed !== null ? C.ghost : C[n.status];
    const every = n.status === 'assumed' || n.status === 'rejected' || n.removed !== null ? 2 : 1;
    const base = (n.removed !== null ? 0.4 : n.status === 'agreed' ? 0.55 : 0.42) * focus(n);
    for (let s = 0; s <= steps * grow; s += every) {
      const [px, py] = f(s / steps);
      S.dot(px, py, tone(col), glow(0, base * ghostK));
      if (n.status === 'agreed' && n.removed === null) S.dot(px, py + 1, tone(col), glow(0, base * 0.7)); // agreed = thicker axon
    }
    if (n.removed !== null || off) continue;
    // dendrites on the goal side of the node
    const back = Math.atan2(sy - yy, sx - x), nb = n.status === 'agreed' ? 4 : n.status === 'open' ? 3 : 2;
    for (let b = 0; b < nb; b++) {
      const a = back + (b - (nb - 1) / 2) * 0.6 + Math.sin(t * 0.8 + n.seed * 20 + b) * 0.1, L = 3 + 3 * ((n.seed * 7 + b * 0.37) % 1);
      S.line(x, yy, x + Math.cos(a) * L, yy + Math.sin(a) * L, tone(col), glow(0, 0.4));
    }
    // travelling impulses: agreed fire outward steadily, open questions send signals back to the goal
    const period = (n.status === 'agreed' ? 2.2 : n.status === 'open' ? 3.4 : 0) * (busy ? 0.45 : 1);
    if (period && grow >= 1) {
      const p = (t / period + n.seed) % 1, travel = 0.55;
      if (p < travel) {
        const u0 = p / travel;
        for (let k = 0; k < 5; k++) {
          const u = n.status === 'agreed' ? u0 - k * 0.025 : 1 - u0 + k * 0.025;
          if (u < 0 || u > 1) continue;
          const [px, py] = f(u);
          S.dot(px, py, mix(C[n.status], C.spark, 0.6), 1 - k * 0.18);
        }
      }
    }
    const da = now - attnT(n);
    if (da < 900 && !off) { // arrival: a bright spark shoots down the synapse
      const u = da / 900;
      for (let k = 0; k < 7; k++) { const v = u - k * 0.03; if (v >= 0) { const [px, py] = f(v); S.dot(px, py, C.spark, 1 - k * 0.12); S.dot(px, py + 1, C.spark, 0.7 - k * 0.09); } }
    }
    if (da < 3200) { // then three rings pulse out from the node
      for (let k = 0; k < 3; k++) { const p = (da - 600 - k * 450) / 1500; if (p >= 0 && p < 1) S.ring(x, yy, 3 + 22 * easeOut(p), mix(C[n.status], C.spark, 0.6), 1 - p); }
    }
  }
  // the goal neuron
  const gk = model.goal ? 1 : 0.4;
  for (let rr = 1; rr <= 3; rr++) S.ring(cx, cy, rr, tone(C.goal), glow(0, 0.75 * gk));
  S.ring(cx, cy, 5 + Math.sin(t * (busy ? 5 : 1.6)) * (busy ? 1.4 : 0.8), tone(waitingP ? C.open : C.goal), glow(0, (busy || waitingP ? 0.8 : 0.55) * gk));
  S.ring(cx, cy, 9 + Math.sin(t * 1.1 + 1) * 1.2, tone(C.goal), glow(0, 0.2 * gk), 2);
  if (goalFresh) { const p = clamp((now - model.goalChanged) / 1800, 0, 1); if (p < 1) S.ring(cx, cy, 6 + 20 * easeOut(p), C.spark, 1 - p); }
  S.text(Math.floor(cx / 2), S.gy + Math.floor(cy / 4), model.goal ? '◉' : '◌', tone(C.goal, gk), true);

  // nodes and their full text
  for (const n of ghosts) if (n.last) {
    const c = Math.floor(n.last[0] / 2), r = S.gy + Math.floor(n.last[1] / 4);
    if (r < S.gy + S.gh) S.text(c, r, '·', C.ghost.map(v => v * (1 - (now - n.removed) / 1600)), true);
  }
  for (const n of placed) {
    const {side, c, r} = n.cell, f = fresh(n);
    const sel = n.id === model.sel, wave = 0.5 + 0.5 * Math.sin(t * 2.2 + n.seed * 6);
    const pulse = n.status === 'open' ? 0.65 + 0.35 * Math.sin(t * 3 + n.seed * 6) : n.status === 'assumed' ? 0.55 + 0.45 * wave : 1;
    // assumptions waver between ○ and ◌: a thought that isn't confirmed yet
    const glyph = n.status === 'assumed' && !off && wave < 0.3 ? '◌' : GLYPH[n.status];
    S.text(c, r, glyph, tone(f ? mix(C[n.status], C.goal, 0.4) : C[n.status], pulse * Math.max(0.55, focus(n))), true);
    // selected: keep the status colour (so an assumption still reads as one) and breathe toward white
    const tcol = sel ? mix(C[n.status], C.goal, 0.1 + 0.3 * (0.5 + 0.5 * Math.sin(t * 3))) : tone(f ? mix(C[n.status], C.goal, 0.55) : mix(C[n.status], C.text, 0.55), f ? 1 : 0.95 * focus(n));
    const ncol = tone(mix(C.goal, C.dim, 0.35), Math.max(0.6, focus(n)));
    const da = now - attnT(n), rec = recent(n);
    // recent items pulse between their colour and bright white; the first 0.7s the text types itself in
    const pcol = rec ? mix(C[n.status], C.goal, 0.45 + 0.4 * (0.5 + 0.5 * Math.sin(t * (da < FRESH_MS ? 6 : 2.5)))) : null;
    let budget = da < 700 ? Math.floor(n.lines.reduce((a, l) => a + [...l].length, 0) * da / 700) : Infinity;
    n.lines.forEach((l, i) => {
      const isNote = i >= (n.textLines || n.lines.length), cp = [...l], shown = budget === Infinity ? l : cp.slice(0, Math.max(0, budget)).join('');
      budget -= cp.length;
      S.text(side === 'left' ? 1 : c + 2, r + i, shown, isNote ? ncol : sel ? tcol : pcol ? tone(pcol) : tcol, !isNote && (f || sel || rec || n.rank === 0));
      if (side === 'right') S.text(c + 1, r + i, ' ', null);
    });
    if (rec) { // "new ✦" / "changed ✦" just left of the node, so it never mixes with the item's text
      const tag = n.changed > (n.arrived ?? -1e12) ? 'changed ✦' : 'new ✦', tx = c - 2 - [...tag].length;
      if (tx >= 0) S.text(tx, r, tag, tone(mix(C.spark, C.goal, 0.5 + 0.5 * Math.sin(t * 4))), true);
    }
    if (sel) S.text(side === 'left' ? c + 1 : c - 1, r, side === 'left' ? '◂' : '▸', mix(C[n.status], C.goal, 0.3), true);
    if (side === 'left') { // dotted leader from the end of the first line to the node
      const from = (1 + [...n.lines[0]].length) * 2 + 2, py = (r - S.gy) * 4 + 2;
      for (let px = from; px < c * 2 - 1; px += 3) S.dot(px, py, tone(C[n.status]), glow(0, 0.3));
    }
  }
  for (const {sg, r, i} of segRows) {
    const isOpen = sg === open, k = isOpen ? 1 : Math.max(0.5, 1 - i * 0.1), isFresh = sg.list.some(recent);
    if (isFresh) S.text(Math.max(0, lx - 2), r, '✦', tone(mix(C.spark, C.goal, 0.5 + 0.5 * Math.sin(t * 4))), true);
    const parts = [['agreed', '●'], ['open', '◆'], ['assumed', '○'], ['rejected', '✕']].map(([st2, g]) => [st2, g, sg.list.filter(n => n.status === st2).length]).filter(p => p[2]);
    const countStr = parts.map(([, g, c]) => `${g} ${c}`).join(' '), cl = [...countStr].length;
    const name = truncate(sg.name, Math.max(3, ltw - cl - 1));
    S.text(lx, r, name, isOpen ? C.goal : tone(isFresh ? C.spark : C.text, k), isOpen || isFresh);
    let x = lx + ltw - cl;
    for (const [st2, g, c] of parts) { const txt = `${g} ${c}`; S.text(x, r, txt, tone(C[st2], k)); x += [...txt].length + 1; }
    S.text(nodeCol.left, r, '◈', isOpen ? C.goal : tone(C.mesh, 1.4 * k), true);
    if (isOpen) S.text(nodeCol.left + 1, r, '▸', C.goal, true);
  }
  if (opt.help) drawHelp(S, W, H);
  // empty states: tell a new user what happens next
  if (!opt.help && (!st || !alive.length) && S.gh >= 4) {
    const lines = !st
      ? ['No consensus yet.', 'Start Claude Code with the Consensus Harness plugin;', 'decisions you make together appear here.', 'Press ? to see how it works.']
      : ['Nothing recorded yet.', 'Talk with Claude: decisions you agree on appear here.', 'Press ? to see how it works.'];
    const top = S.gy + Math.max(0, Math.floor(S.gh / 2) + 2);
    lines.forEach((l, i) => { const t = truncate(l, W - 2); S.text(Math.max(1, Math.floor((W - [...t].length) / 2)), Math.min(S.gy + S.gh - 1, top + i), t, i === lines.length - 1 ? C.goal : C.dim, i === lines.length - 1); });
  }
  return S.render(color, rowPrefix);
}

// ---------- acting on items: select with arrows, then a / o / x ----------
// ↵: jump to the next item that waits for the user (assumed or open), in whatever topic it is
function nextNeed() {
  const list = model.needs;
  if (!list.length) return say('✓ nothing waits for you', C.agreed);
  const i = list.indexOf(model.sel), id = list[(i + 1) % list.length], n = model.nodes.get(id);
  if (!n) return;
  const topic = n.topic || 'General';
  model.openSeg = topic; model.segManual = topic !== model.segNames[0];
  model.offset = 0; model.pages = []; model.sel = id;
  say(`⚑ ${list.indexOf(id) + 1} of ${list.length} waiting · a agree · d disagree · n note`, C.open);
}
function switchTopic(d) {
  const names = model.segNames;
  if (names.length < 2) return;
  const i = Math.max(0, names.indexOf(model.openSeg)), j = clamp(i + d, 0, names.length - 1);
  if (j === i) return;
  model.openSeg = names[j]; model.segManual = j !== 0; // back on the newest topic = follow new topics again
  model.offset = 0; model.pages = []; model.sel = null;
}
function say(text, col) { model.msg = {text, col, until: Date.now() + 3500}; }
function move(d) {
  const o = model.order;
  if (!o.length) return;
  const i = o.indexOf(model.sel);
  // first press lands on the first assumption: that's what usually needs your answer
  if (i < 0) { const vis = o.slice(model.offset); model.sel = vis.slice(0, model.pageCount).find(id => model.nodes.get(id)?.status === 'assumed') || vis[0] || o[0]; return; }
  model.sel = o[(i + d + o.length) % o.length];
}
function runState(st, args, input) {
  const env = {...process.env, CONSENSUS_PROJECT: st.project, CONSENSUS_BY: 'user'}; // tells Claude this was your decision
  if (st.session) env.CONSENSUS_SESSION = String(st.session); else delete env.CONSENSUS_SESSION;
  execFileSync(process.execPath, [STATE_CLI, ...args], {env, input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000});
  lastPoll = 0;
}
function addNote(text) {
  const st = model.state, n = model.sel && model.nodes.get(model.sel);
  if (!st || !n) return;
  if (!fs.existsSync(STATE_CLI)) return say('state script not found: set CONSENSUS_STATE_CLI', C.ghost);
  try { runState(st, ['note', n.id, '-'], text); say('↳ note added', C.open); }
  catch (e) { say(String(e.stderr || e.message).trim().split('\n')[0] || 'write failed', C.ghost); }
}
function act(kind) {
  const st = model.state, n = model.sel && model.nodes.get(model.sel);
  if (!st || !n) return;
  if (st.enabled === false) return say('harness is off: nothing changed', C.ghost);
  if (kind === n.status) return say(`already ${kind}`, C[kind]);
  if (!fs.existsSync(STATE_CLI)) return say('state script not found: set CONSENSUS_STATE_CLI', C.ghost);
  if (kind === 'remove' && Date.now() - model.confirmX > 2500) { model.confirmX = Date.now(); return say('press x again to forget this item (to say no, use d)', C.open); }
  model.confirmX = 0;
  const args = kind === 'remove' ? ['remove', n.id] : ['edit', n.id, kind, '-'];
  try {
    runState(st, args, n.text);
    if (kind === 'remove') { const o = model.order, i = o.indexOf(n.id); model.sel = o[i + 1] || o[i - 1] || null; }
    say(kind === 'remove' ? '· forgotten' : `${GLYPH[kind]} marked ${kind}`, kind === 'remove' ? C.ghost : C[kind]);
    return true;
  } catch (e) { say(String(e.stderr || e.message).trim().split('\n')[0] || 'write failed', C.ghost); }
}

// ---------- run ----------
if (opt.once) {
  const [W, H] = opt.size, now = Date.now();
  poll(now - 20000);
  if (opt.offset) model.offset = opt.offset;
  if (opt.topic) { model.openSeg = opt.topic; model.segManual = true; }
  for (let i = 0; i < 40; i++) frame(now - 4000 + i * 100, W, H); // settle angles
  if (opt.select) model.sel = model.order[opt.select - 1] || null;
  console.log(frame(now, W, H, !process.env.NO_COLOR && process.stdout.isTTY).join('\n'));
  process.exit(0);
}

const out = process.stdout;
if (!out.isTTY) { console.error('consensus-brain needs a terminal (or use --once).'); process.exit(1); }
out.write('\x1b[?1049h\x1b[?25l\x1b[2J');
if (!opt.bgSet) out.write('\x1b]11;?\x1b\\'); // ask for the background colour; the answer arrives as input
const restore = () => out.write('\x1b[0m\x1b[?25h\x1b[?1049l');
process.on('exit', restore);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
out.on('resize', () => out.write('\x1b[2J'));

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', d => {
    const k = d.toString();
    const bgm = /\x1b\]11;rgb:([0-9a-f]{2})[0-9a-f]*\/([0-9a-f]{2})[0-9a-f]*\/([0-9a-f]{2})/i.exec(k);
    if (bgm) { if (!opt.bgSet) BG = [1, 2, 3].map(j => parseInt(bgm[j], 16)); return; }
    if (model.input) { // typing a note: enter saves, esc cancels
      if (k === '\x03') process.exit(0);
      else if (k === '\x1b') model.input = null;
      else if (k === '\r' || k === '\n') { const t = model.input.text.trim(); model.input = null; if (t) addNote(t); }
      else if (k === '\x7f' || k === '\b') model.input.text = [...model.input.text].slice(0, -1).join('');
      else if (!k.startsWith('\x1b')) model.input.text += k.replace(/[\x00-\x1f\x7f]/g, ' ');
      return;
    }
    if (k === '?') opt.help = !opt.help;
    else if (k === '\x1b' && opt.help) opt.help = false;
    else if (k === '\x1b' && model.sel) model.sel = null;
    else if (k === 'q' || k === '\x03' || k === '\x1b') process.exit(0);
    else if (k === '\x1b[A' || k === 'k') move(-1);
    else if (k === '\x1b[B' || k === 'j') move(1);
    else if (k === '\x1b[C' || k === 'l') switchTopic(1);   // → older topic
    else if (k === '\x1b[D' || k === 'h') switchTopic(-1);  // ← newer topic
    else if (k === '\x1b[6~' || k === ']') { if (model.offset + model.pageCount < model.order.length) { model.pages.push(model.offset); model.offset += model.pageCount; model.sel = null; } }
    else if (k === '\x1b[5~' || k === '[') { if (model.offset > 0) { model.offset = model.pages.length ? model.pages.pop() : Math.max(0, model.offset - Math.max(1, model.pageCount)); model.sel = null; } }
    else if (k === 'g' || k === '\x1b[H' || k === '\x1b[1~') { model.segManual = false; model.offset = 0; model.pages = []; model.sel = null; }
    else if (model.sel && k === 'a') act('agreed');
    else if (model.sel && k === 'o') act('open');
    else if (model.sel && k === 'x') act('remove');
    else if (k === '\r' || k === '\n') nextNeed();
    else if (model.sel && k === 'd') { if (act('rejected')) model.input = {text: '', label: 'why? (optional): '}; }
    else if (model.sel && k === 'n') { if (model.state?.enabled === false) say('harness is off: nothing changed', C.ghost); else model.input = {text: ''}; }
    else if (k === 'm') opt.mesh = !opt.mesh;
    else if (k === 'p') { model.pinned = !model.pinned; lastPoll = 0; }
    else if (k === '\t') {
      const all = listStates();
      if (all.length) { const i = all.findIndex(s => s.file === model.file); model.pinned = true; load(all[(i + 1) % all.length], Date.now()); }
    }
  });
}

let lastPoll = 0;
const tick = () => {
  const now = Date.now();
  if (now - lastPoll > 400) { poll(now); lastPoll = now; }
  const W = out.columns || 80, H = out.rows || 24;
  out.write(frame(now, W, H, true, y => `\x1b[${y + 1};1H`).join(''));
};
tick();
setInterval(tick, 66);
