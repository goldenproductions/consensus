// Live activity for the Consensus viewer: what Claude is doing right now in this session.
// Runs on UserPromptSubmit, PreToolUse, Notification, Stop and SessionEnd. Writes one small file per session
// (~/.consensus-harness/activity/<session>.json), prints nothing and always exits 0, so it never affects Claude.
// Labels come from the tool's own user-facing description or a file name, never from command text.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {load, resolveProject, getPaths} from './state.mjs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let input = {};
try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { process.exit(0); }
const session = String(input.session_id || '');
// CONSENSUS_DEBUG_HOOKS=1: append every raw hook event (minus tool input bodies) to logs/hooks.jsonl, to see what an agent sends.
if (process.env.CONSENSUS_DEBUG_HOOKS === '1') {
  try {
    const {tool_input, ...rest} = input;
    const dir = path.join(process.env.CONSENSUS_HOME || path.join(os.homedir(), '.consensus-harness'), 'logs');
    fs.mkdirSync(dir, {recursive: true});
    fs.appendFileSync(path.join(dir, 'hooks.jsonl'), JSON.stringify({at: Date.now(), ...rest, tool_input_keys: tool_input ? Object.keys(tool_input) : undefined}) + '\n');
  } catch {}
}
if (!session) process.exit(0);
const project = resolveProject(input.cwd || process.cwd());
try { if (!load(project).enabled) process.exit(0); } catch { process.exit(0); }

const base = p => (p ? path.basename(String(p)) : '');
const short = (s, n = 70) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
function describe(tool, ti = {}) {
  switch (tool) {
    case 'Read': return `reading ${base(ti.file_path)}`;
    case 'Edit': case 'MultiEdit': return `editing ${base(ti.file_path)}`;
    case 'Write': return `writing ${base(ti.file_path)}`;
    case 'NotebookEdit': return `editing ${base(ti.notebook_path)}`;
    case 'Bash': return ti.description ? short(ti.description).replace(/^./, c => c.toLowerCase()) : 'running a command';
    case 'Grep': case 'Glob': return 'searching the code';
    case 'WebFetch': case 'WebSearch': return 'reading the web';
    case 'Agent': case 'Task': return ti.description ? `delegating: ${short(ti.description, 50)}` : 'delegating to an agent';
    case 'TodoWrite': return 'planning';
    default: return tool ? `using ${String(tool).replace(/^mcp__[^_]+__/, '')}` : 'working';
  }
}

// What kind of work, so the viewer can colour it: read, edit, run, delegate, web, plan, tool.
function kindOf(tool) {
  if (['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'].includes(tool)) return 'read';
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(tool)) return 'edit';
  if (tool === 'Bash') return 'run';
  if (tool === 'Agent' || tool === 'Task') return 'delegate';
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'web';
  if (tool === 'TodoWrite') return 'plan';
  return 'tool';
}

const event = input.hook_event_name || '';
// Which assistant is running: Codex keeps its transcripts under ~/.codex (or $CODEX_HOME), Claude Code under ~/.claude.
const agent = /[\\/]\.codex[\\/]/.test(String(input.transcript_path || '')) || (process.env.CODEX_HOME && String(input.transcript_path || '').startsWith(process.env.CODEX_HOME)) ? 'Codex' : 'Claude';
const file = path.join(getPaths(project).root, 'activity', `${session.replace(/[^\w-]/g, '_')}.json`);
let prev = {};
try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
let next = null;
if (event === 'UserPromptSubmit') next = {state: 'thinking', kind: 'think', label: 'thinking', steps: 0};
else if (event === 'PreToolUse') next = {state: 'working', kind: kindOf(input.tool_name), label: describe(input.tool_name, input.tool_input || {}), steps: (prev.steps || 0) + 1};
else if (event === 'PermissionRequest') next = {state: 'waiting', label: `needs your permission${input.tool_name ? ` to use ${String(input.tool_name).replace(/^mcp__[^_]+__/, '')}` : ''}`, steps: prev.steps || 0};
else if (event === 'Notification') next = {state: 'waiting', label: short(input.message || 'needs your attention', 80), steps: prev.steps || 0};
else if (event === 'Stop') next = {state: 'idle', label: 'your turn', steps: prev.steps || 0};
else if (event === 'SessionEnd') next = {state: 'ended', label: 'session ended', steps: prev.steps || 0};
if (!next) process.exit(0);

// Decision trace: file edits are linked to the item the AI said it is working on ("work <id>"),
// so the viewer can show which files each decision touched and flag edits that rest on no agreed item.
const editPaths = () => {
  const ti = input.tool_input || {}, out = [];
  for (const k of ['file_path', 'notebook_path', 'path']) if (typeof ti[k] === 'string') out.push(ti[k]);
  // Codex apply_patch: "*** Update File: path" lines anywhere in the input
  for (const v of Object.values(ti)) if (typeof v === 'string') for (const m of v.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(m[1].trim());
  return [...new Set(out)];
};
if (event === 'PreToolUse' && (next.kind === 'edit' || /patch/i.test(String(input.tool_name || '')))) {
  try {
    const st = load(project, session), w = st.working && st.items.find(x => x.id === st.working.id);
    const tfile = path.join(getPaths(project).root, 'trace', `${session.replace(/[^\w-]/g, '_')}.json`);
    let tr = {}; try { tr = JSON.parse(fs.readFileSync(tfile, 'utf8')); } catch {}
    tr.items = tr.items || {};
    const key = w ? w.id : '_unlinked';
    for (const p of editPaths()) {
      const rel = path.isAbsolute(p) && p.startsWith(project + path.sep) ? path.relative(project, p) : p;
      const e = (tr.items[key] = tr.items[key] || {files: {}});
      e.files[rel] = (e.files[rel] || 0) + 1; e.last = Date.now(); e.status = w ? w.status : 'none';
    }
    fs.mkdirSync(path.dirname(tfile), {recursive: true, mode: 0o700});
    fs.writeFileSync(`${tfile}.${process.pid}.tmp`, JSON.stringify(tr) + '\n', {mode: 0o600}); fs.renameSync(`${tfile}.${process.pid}.tmp`, tfile);
    if (w) next.item = w.id;
  } catch {}
}
try {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({session, project, agent, ...next, at: Date.now()}) + '\n', {mode: 0o600});
  fs.renameSync(tmp, file);
} catch {}
process.exit(0);
