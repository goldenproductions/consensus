// Long-term memory: each session's consensus is compacted into a per-project memory file automatically.
// Like a real conversation partner: recent sessions are remembered with their decisions, older ones only
// as a gist. Home-folder sessions (unrelated topics) only keep a one-line goal index.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {getPaths, load, isSharedDir, resolveProject} from './state.mjs';

const FULL = 3;        // newest sessions shown with their decisions
const SHOWN = 12;      // sessions shown at all (older ones: gist only)
const KEEP = 60;       // sessions kept on disk
const HOME_INDEX = 8;  // home folder: goal lines shown
const MAX_OPEN = 5;    // open questions kept per session

function memFile(project) {
  const key = crypto.createHash('sha256').update(path.resolve(project)).digest('hex').slice(0, 20);
  return path.join(getPaths(project).root, 'memory', `${key}.json`);
}
export function loadMemory(project) {
  try {
    const m = JSON.parse(fs.readFileSync(memFile(project), 'utf8'));
    if (Array.isArray(m.episodes)) return m;
  } catch {}
  return {version: 1, project: path.resolve(project), episodes: []};
}
function saveMemory(mem, project) {
  const file = memFile(project);
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(mem, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(tmp, file);
}

// The compact form of a consensus: goal, gist, and what was decided (agreed, rejected, a few open questions).
function compact(st, session) {
  const times = st.items.map(x => x.at).filter(Boolean);
  const pick = s => st.items.filter(x => x.status === s);
  const decision = x => ({status: x.status, topic: x.topic || '', text: x.text, notes: (x.notes || []).filter(n => n.by === 'user').map(n => n.text), ...(x.done ? {done: x.done.note || true} : {})});
  return {
    session,
    start: times.length ? Math.min(...times) : Date.now(),
    end: Date.now(),
    goal: st.goal || '',
    why: st.why || '',
    earlier: (st.goals || []).map(g => g.goal).filter(Boolean), // goals this session had before its last one
    gist: (st.gist || '').replace(/\s*\n\s*/g, ' '),
    decisions: [...pick('agreed'), ...pick('rejected'), ...pick('open').slice(-MAX_OPEN)].map(decision),
  };
}

// Save (or refresh) this session's episode. Called on every prompt and at session end, so it is always current.
export function archive(project, session, state = null) {
  const st = state || load(project, session);
  if (!st.goal && !st.items.length) return false;
  const mem = loadMemory(project);
  const ep = compact(st, session);
  const i = mem.episodes.findIndex(e => e.session === session);
  if (i >= 0) { ep.start = Math.min(ep.start, mem.episodes[i].start || ep.start); mem.episodes[i] = ep; }
  else mem.episodes.push(ep);
  mem.episodes.sort((a, b) => a.end - b.end);
  mem.episodes = mem.episodes.slice(-KEEP);
  saveMemory(mem, project);
  return true;
}

// One-time: a folder state from before memory existed becomes the first episode. The folder file is kept.
export function migrateFolderState(project) {
  const folder = load(project);
  if (folder.migrated || (!folder.goal && !folder.items.length)) return false;
  const ep = compact(folder, 'before-memory');
  const times = folder.items.map(x => x.updated || x.at).filter(Boolean);
  if (times.length) ep.end = Math.max(...times);
  else { try { ep.end = fs.statSync(getPaths(project).file).mtimeMs; } catch {} }
  const mem = loadMemory(project);
  if (!mem.episodes.some(e => e.session === 'before-memory')) { mem.episodes.push(ep); mem.episodes.sort((a, b) => a.end - b.end); saveMemory(mem, project); }
  folder.migrated = true;
  const {file} = getPaths(project);
  fs.writeFileSync(file, JSON.stringify(folder, null, 2) + '\n', {mode: 0o600});
  return true;
}

const day = t => new Date(t).toISOString().slice(0, 10);

// What a new session is told. Excludes the current session's own episode.
export function renderMemory(project, currentSession = '') {
  const eps = loadMemory(project).episodes.filter(e => e.session !== currentSession).sort((a, b) => b.end - a.end);
  if (!eps.length) return '';
  if (isSharedDir(project)) {
    const lines = eps.slice(0, HOME_INDEX).map(e => `- ${day(e.end)}: ${e.goal || e.gist || '(no goal agreed)'}`);
    return `Earlier sessions started in this folder (goals only; unrelated topics, mention one only if the user returns to it):\n${lines.join('\n')}`;
  }
  const out = eps.slice(0, SHOWN).map((e, i) => {
    let s = `- ${day(e.end)} · ${e.goal || '(no goal agreed)'}`;
    if (e.why) s += `\n  why: ${e.why}`;
    if (e.earlier?.length) s += `\n  earlier goals in that session: ${e.earlier.join(' · ')}`;
    if (e.gist) s += `\n  gist: ${e.gist.replace(/\s*\n\s*/g, ' ')}`;
    if (i < FULL) {
      for (const d of e.decisions) s += `\n  ${d.status.toUpperCase()}${d.done ? ` (done${d.done === true ? '' : `: ${d.done}`})` : ''}${d.topic ? ` {${d.topic}}` : ''}: ${d.text}${d.notes.length ? ` (user note: ${d.notes.join('; ')})` : ''}`;
    } else if (!e.gist) {
      const top = e.decisions.filter(d => d.status === 'agreed').slice(0, 2).map(d => d.text);
      if (top.length) s += `\n  agreed: ${top.join(' · ')}`;
    }
    return s;
  });
  const more = eps.length > SHOWN ? `\n(${eps.length - SHOWN} older sessions not shown)` : '';
  return `Long-term memory for this project, compacted from past sessions (newest first). It is background, not today's agreements: build on it, the user's current words win, and re-confirm an old detail before relying on it. Never re-propose something marked REJECTED here.\n${out.join('\n')}${more}`;
}

// CLI for inspection: node memory.mjs [show|json]
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const project = resolveProject(process.cwd());
  const cmd = process.argv[2] || 'show';
  if (cmd === 'json') console.log(JSON.stringify(loadMemory(project), null, 2));
  else console.log(renderMemory(project, process.env.CONSENSUS_SESSION || '') || 'No long-term memory for this project yet.');
}
