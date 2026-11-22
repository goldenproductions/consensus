// Auto-wake: after the AI finishes a reply, wait in the background for the user's changes in the Consensus viewer
// and hand them to the AI right away, so the user never has to type in the chat to make it see them.
// Claude Code runs this as an asyncRewake hook: exit code 2 wakes the model with stderr as the message.
// Codex has no such hook, so there the watcher detaches and delivers the message with `codex queue`.
// It stops quietly when the user prompts first, when auto-wake is off, or after an hour.
import fs from 'node:fs';
import path from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {load, resolveProject, getPaths, readSeen, markSeen, eventLine} from './state.mjs';

const QUIET_MS = 4000;          // wait this long after the last viewer change (the user may do several)
const TYPING_MS = 120000;       // a note being typed holds the wake back, up to this long
const LIFETIME_MS = 55 * 60000; // give up after this
const TICK_MS = 1000;

const isChild = process.argv[2] === '--child';
let input = {};
if (isChild) input = JSON.parse(process.argv[3] || '{}');
else {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { process.exit(0); }
}
const session = String(input.session_id || '');
if (!session) process.exit(0);
const project = resolveProject(input.cwd || process.cwd());
const root = getPaths(project).root;
const safe = session.replace(/[^\w-]/g, '_');
const isCodex = /[\\/]\.codex[\\/]/.test(String(input.transcript_path || '')) || (process.env.CODEX_HOME && String(input.transcript_path || '').startsWith(process.env.CODEX_HOME));

const enabled = () => { try { return load(project).enabled; } catch { return false; } };
const autoWakeOff = () => { try { return JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')).autoWake === false; } catch { return false; } };
if (!enabled() || autoWakeOff()) process.exit(0);

// Codex would wait for this hook, so run the watcher as a detached process and return at once.
if (isCodex && !isChild) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', JSON.stringify(input)], {detached: true, stdio: 'ignore', env: process.env});
  child.unref();
  process.exit(0);
}

const start = Date.now();
const activity = () => { try { return JSON.parse(fs.readFileSync(path.join(root, 'activity', `${safe}.json`), 'utf8')); } catch { return {}; } };
const typing = () => { try { return Date.now() - fs.statSync(path.join(root, 'typing', safe)).mtimeMs < TYPING_MS; } catch { return false; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

while (Date.now() - start < LIFETIME_MS) {
  await sleep(TICK_MS);
  // the user wrote in the chat (or the AI is busy again): the prompt hook announces the changes, so stop here
  const a = activity();
  if (a.at > start && (a.state === 'thinking' || a.state === 'working')) process.exit(0);
  if (a.state === 'ended') process.exit(0);
  if (!enabled() || autoWakeOff()) process.exit(0);
  let st; try { st = load(project, session); } catch { continue; }
  const seen = readSeen(project, session) ?? start;
  const evs = (st.events || []).filter(e => e.by === 'user' && e.at > seen);
  if (!evs.length || typing()) continue;
  if (Date.now() - Math.max(...evs.map(e => e.at)) < QUIET_MS) continue;

  markSeen(project, session);
  const msg = `The user just changed the consensus in the Consensus viewer (no chat message). These are the user's own decisions: acknowledge them in one short line, act on them if they unblock or change your work, and do not ask about them again or revert them:\n${evs.map(eventLine).join('\n')}`;
  if (isCodex) {
    try { execFileSync('codex', ['queue', '--thread', session, '--message', msg], {stdio: 'ignore', timeout: 30000}); } catch {}
    process.exit(0);
  }
  process.stderr.write(msg + '\n');
  process.exit(2);
}
process.exit(0);
