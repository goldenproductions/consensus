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
  else if (a === '--once') opt.once = true;
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
const FRESH_MS = 6000;

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
      try { out.push({file, mtime: fs.statSync(file).mtimeMs}); } catch {}
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
function readJSON(file) { try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(s.items) ? s : null; } catch { return null; } }

const model = {file: null, mtime: 0, state: null, nodes: new Map(), goal: '', goalChanged: -1e12, pinned: !!opt.project, first: true,
  sel: null, order: [], confirmX: 0, msg: null, offset: 0, pages: [], pageCount: 0, input: null};

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
      n = {id: it.id, seed: hash(it.id), a: null, born: model.first ? now + i * 110 : now, changed: -1e12, removed: null};
      model.nodes.set(it.id, n);
    } else if (n.status !== status || n.text !== text || n.removed !== null) n.changed = now;
    Object.assign(n, {status, text, order: i, removed: null, time: Number(it.updated || it.at) || 0, notes: Array.isArray(it.notes) ? it.notes : []});
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
const poll = now => { load(pickFile(), now); if (model.state?.session) model.state.enabled = folderEnabled(model.state); };

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
          const code = col ? `\x1b[${b ? 1 : 22};38;2;${col[0] | 0};${col[1] | 0};${col[2] | 0}m` : '\x1b[0m';
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
  'Talk with Claude as usual. Goal and decisions land here.',
  "○ is Claude's assumption. ↓ select it: a agree, d disagree, n note.",
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
  for (const l of wrap('↑↓ select, then a agree · d disagree · o open · n note · x x forget it · ←→ newer/older page · g newest · tab next consensus · p pin · m mesh · ? / esc close · q quit', boxW - 4)) rows.push({kind: 'plain', text: l});
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
  const fresh = n => now - Math.max(n.born, n.changed) < FRESH_MS && now >= n.born;

  // header
  let y = 0;
  const name = !st ? 'no consensus yet' : (path.resolve(st.project || '/') === HOME ? '~' : path.basename(st.project || '/')) + (st.session ? ` · session ${String(st.session).slice(0, 8)}` : '');
  const age = st ? fmtAge(Date.now() - model.mtime) : '';
  const tail = (off ? 'OFF' : '') + (off && W >= 44 ? '  ' : '') + (W >= 44 ? age : '');
  const named = W >= 60; // legend: wide panes name each colour, narrow ones show only the symbols
  const parts = [[`● ${counts.agreed}${named ? ' agreed' : ''}`, C.agreed], [`◆ ${counts.open}${named ? ' open' : ''}`, C.open], [`○ ${counts.assumed}${named ? ' assumed' : ''}`, C.assumed]];
  if (counts.rejected) parts.push([`✕ ${counts.rejected}${named ? ' rejected' : ''}`, C.rejected]);
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
  S.text(0, y++, '─'.repeat(W), tone(C.dim, 0.5));

  // footer
  const hintRow = H - 1;
  const hint = model.sel
    ? (W >= 84 ? 'a agree · d disagree · o open · n note · x forget · esc done' : W >= 40 ? 'a · d · o · n · x · esc' : 'esc')
    : (W >= 72 ? 'q quit · ↑↓ select · ←→ newer/older · ? help' : W >= 40 ? 'q · ↑↓ · ←→ · ? help' : '? help');
  if (model.input) {
    const label = model.input.label || 'note: ', room = Math.max(4, W - label.length - 4), txt = [...model.input.text];
    S.text(1, hintRow, label, C.open, true);
    S.text(1 + label.length, hintRow, (txt.length > room ? '…' + txt.slice(-room + 1).join('') : model.input.text) + '▌', C.goal, true);
  }
  else if (model.msg && Date.now() < model.msg.until) S.text(1, hintRow, truncate(model.msg.text, W - 20), model.msg.col, true);
  else S.text(1, hintRow, hint, model.sel ? C.goal : tone(C.dim, 0.7), !!model.sel);
  const mode = model.input ? 'enter save · esc cancel' : model.pinned ? 'pinned' : W >= 56 ? 'following newest' : 'follow';
  if (!model.input || W >= 60) S.text(W - mode.length - 1, hintRow, mode, tone(model.input ? C.open : model.pinned ? C.open : C.dim, 0.8));
  S.gy = y; S.gh = Math.max(0, hintRow - y);
  if (S.gh < 3) return S.render(color, rowPrefix);

  // ---- layout: every item's full text, wrapped in a column; its node sits on the column's inner edge ----
  // Wide panes: a left and a right column with the goal neuron in the band between them. Narrow: one column.
  const two = W >= 64;
  const band = two ? clamp(Math.floor(W * 0.22), 12, 34) : clamp(Math.floor(W * 0.24), 8, 16);
  const colW = two ? Math.floor((W - band - 2) / 2) : W - band - 1;
  const tw = Math.max(8, colW - 3);
  const nodeCol = {left: tw + 2, right: two ? W - colW - 1 : band};
  const PW = W * 2, PH = S.gh * 4, cy = PH / 2;
  const cx = two ? PW / 2 : nodeCol.right; // goal neuron (pixels): centre, or middle of the left band
  // Pages: newest first. A page holds as many items as fit, starting at model.offset (0 = newest).
  // The top and bottom row of the graph are kept for the "newer" / "older" markers.
  const top = S.gy + 1, rowsAvail = Math.max(1, S.gh - 2);
  const pack = start => {
    const used = {right: 0, left: 0}, out = [];
    for (let i = start; i < alive.length; i++) {
      const textLines = wrap(alive[i].text, tw);
      const lines = textLines.concat(...alive[i].notes.map(nt => wrap('↳ ' + nt.text, tw)));
      alive[i].textLines = textLines.length;
      const side = !two || used.right <= used.left ? 'right' : 'left';
      const gap = used[side] ? 1 : 0;
      if (used[side] + gap + lines.length > rowsAvail) {
        if (!out.length) out.push({n: alive[i], lines: lines.slice(0, rowsAvail), side, row: 0}); // taller than the pane: clip
        break;
      }
      out.push({n: alive[i], lines, side, row: used[side] + gap});
      used[side] += gap + lines.length;
    }
    return {out, h: Math.max(used.right, used.left)};
  };
  model.offset = clamp(model.offset, 0, Math.max(0, alive.length - 1));
  const selIdx = model.sel ? alive.findIndex(n => n.id === model.sel) : -1;
  if (selIdx >= 0 && selIdx < model.offset) { model.offset = selIdx; model.pages = []; }
  let page = pack(model.offset);
  while (selIdx >= model.offset + page.out.length && model.offset < selIdx) { model.offset++; model.pages = []; page = pack(model.offset); } // follow the selection
  model.pageCount = page.out.length;
  for (const n of alive) n.cell = null;
  const base = top + Math.floor((rowsAvail - page.h) / 2);
  for (const {n, lines, side, row} of page.out) {
    n.cell = {side, c: nodeCol[side], r: base + row};
    n.lines = lines;
    n.last = [nodeCol[side] * 2 + 1, (base + row - S.gy) * 4 + 2];
  }
  const newer = model.offset, older = alive.length - model.offset - page.out.length;
  const marker = (row, text) => S.text(Math.max(1, Math.floor((W - [...text].length) / 2)), row, text, tone(C.spark, 0.9), true);
  if (newer) marker(S.gy, `↑ ${newer} newer  ← or g`);
  if (older > 0) marker(S.gy + S.gh - 1, `↓ ${older} older  →`);

  if (opt.mesh) {
    const M = getMesh(PW, PH);
    for (const [i, j] of M.links) {
      const p = M.pts[i], q = M.pts[j];
      S.line(p.x, p.y, q.x, q.y, tone(C.mesh), glow(0, 0.17 + 0.07 * Math.sin(t * p.sp + p.ph)), 2);
    }
    for (const p of M.pts) S.dot(p.x, p.y, tone(C.mesh), glow(0, 0.5 + 0.3 * Math.sin(t * p.sp * 1.7 + p.ph)));
    if (now > M.nextSpark && M.links.length && !off) { M.sparks.push({l: M.links[Math.floor(Math.random() * M.links.length)], s: now}); M.nextSpark = now + 150 + Math.random() * 450; }
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
  const placed = alive.filter(n => n.cell && now >= n.born);
  model.order = alive.map(n => n.id);
  if (model.sel && !model.order.includes(model.sel)) model.sel = null;
  // lobe links between neighbours of the same status in the same column
  for (let i = 1; i < placed.length; i++) {
    const a = placed[i - 1], b = placed[i];
    if (a.status === b.status && a.cell.side === b.cell.side) S.line(...a.last, ...b.last, tone(C[a.status]), glow(0, 0.18), 2);
  }
  // synapses: goal <-> item; a new item's synapse grows out of the goal
  for (const n of [...placed, ...ghosts.filter(g => g.last)]) {
    const [x, yy] = n.last;
    const sx = cx, sy = cy;
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
    const back = Math.atan2(cy - yy, cx - x), nb = n.status === 'agreed' ? 4 : n.status === 'open' ? 3 : 2;
    for (let b = 0; b < nb; b++) {
      const a = back + (b - (nb - 1) / 2) * 0.6 + Math.sin(t * 0.8 + n.seed * 20 + b) * 0.1, L = 3 + 3 * ((n.seed * 7 + b * 0.37) % 1);
      S.line(x, yy, x + Math.cos(a) * L, yy + Math.sin(a) * L, tone(col), glow(0, 0.4));
    }
    // travelling impulses: agreed fire outward steadily, open questions send signals back to the goal
    const period = n.status === 'agreed' ? 2.2 : n.status === 'open' ? 3.4 : 0;
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
    if (fresh(n)) {
      const p = clamp((now - Math.max(n.born, n.changed)) / 1400, 0, 1);
      if (p < 1) S.ring(x, yy, 2 + 12 * easeOut(p), mix(C[n.status], C.spark, 0.5), 1 - p);
    }
  }
  // the goal neuron
  const gk = model.goal ? 1 : 0.4;
  for (let rr = 1; rr <= 3; rr++) S.ring(cx, cy, rr, tone(C.goal), glow(0, 0.75 * gk));
  S.ring(cx, cy, 5 + Math.sin(t * 1.6) * 0.8, tone(C.goal), glow(0, 0.55 * gk));
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
    const pulse = n.status === 'open' ? 0.65 + 0.35 * Math.sin(t * 3 + n.seed * 6) : 1;
    S.text(c, r, GLYPH[n.status], tone(f ? mix(C[n.status], C.goal, 0.4) : C[n.status], pulse * Math.max(0.55, focus(n))), true);
    const sel = n.id === model.sel;
    const tcol = sel ? C.goal : tone(f ? mix(C[n.status], C.goal, 0.55) : mix(C[n.status], C.text, 0.55), f ? 1 : 0.95 * focus(n));
    const ncol = tone(mix(C.goal, C.dim, 0.35), Math.max(0.6, focus(n)));
    n.lines.forEach((l, i) => { const isNote = i >= (n.textLines || n.lines.length); S.text(side === 'left' ? 1 : c + 2, r + i, l, isNote ? ncol : tcol, !isNote && (f || sel || n.rank === 0)); if (side === 'right') S.text(c + 1, r + i, ' ', null); });
    if (sel) S.text(side === 'left' ? c + 1 : c - 1, r, side === 'left' ? '◂' : '▸', C.goal, true);
    if (side === 'left') { // dotted leader from the end of the first line to the node
      const from = (1 + [...n.lines[0]].length) * 2 + 2, py = (r - S.gy) * 4 + 2;
      for (let px = from; px < c * 2 - 1; px += 3) S.dot(px, py, tone(C[n.status]), glow(0, 0.3));
    }
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
  for (let i = 0; i < 40; i++) frame(now - 4000 + i * 100, W, H); // settle angles
  if (opt.select) model.sel = model.order[opt.select - 1] || null;
  console.log(frame(now, W, H, !process.env.NO_COLOR && process.stdout.isTTY).join('\n'));
  process.exit(0);
}

const out = process.stdout;
if (!out.isTTY) { console.error('consensus-brain needs a terminal (or use --once).'); process.exit(1); }
out.write('\x1b[?1049h\x1b[?25l\x1b[2J');
const restore = () => out.write('\x1b[0m\x1b[?25h\x1b[?1049l');
process.on('exit', restore);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
out.on('resize', () => out.write('\x1b[2J'));

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', d => {
    const k = d.toString();
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
    else if (k === '\x1b[C' || k === 'l') { if (model.offset + model.pageCount < model.order.length) { model.pages.push(model.offset); model.offset += model.pageCount; model.sel = null; } }
    else if (k === '\x1b[D' || k === 'h') { if (model.offset > 0) { model.offset = model.pages.length ? model.pages.pop() : Math.max(0, model.offset - Math.max(1, model.pageCount)); model.sel = null; } }
    else if (k === 'g' || k === '\x1b[H' || k === '\x1b[1~') { model.offset = 0; model.pages = []; }
    else if (model.sel && k === 'a') act('agreed');
    else if (model.sel && k === 'o') act('open');
    else if (model.sel && k === 'x') act('remove');
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
