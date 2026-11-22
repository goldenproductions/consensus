import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

// Project = explicit CONSENSUS_PROJECT, else CLAUDE_PROJECT_DIR, else nearest git root above cwd, else cwd.
// This keeps the same state file when Claude's shell has cd'd into a subfolder.
export function findGitRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
export function resolveProject(cwd = process.cwd()) {
  const explicit = process.env.CONSENSUS_PROJECT || process.env.CLAUDE_PROJECT_DIR;
  if (explicit) return path.resolve(explicit);
  return findGitRoot(cwd) || path.resolve(cwd);
}
function projectKey(cwd, session='') { return crypto.createHash('sha256').update(path.resolve(cwd) + (session ? `\0session:${session}` : '')).digest('hex').slice(0, 20); }
// The home folder (and filesystem root) is where unrelated conversations start, so there the consensus
// belongs to the session, not the folder. The folder state still holds the on/off switch.
export function isSharedDir(dir) { const d = path.resolve(dir); return d === path.resolve(os.homedir()) || d === path.parse(d).root; }
export const SESSION_TTL_DAYS = 30;
export function getPaths(cwd = process.cwd(), session = '') {
  const root = process.env.CONSENSUS_HOME || path.join(os.homedir(), '.consensus-harness');
  const dir = session ? 'sessions' : 'projects';
  return {root, dir: path.join(root, dir), file: path.join(root, dir, `${projectKey(cwd, session)}.json`)};
}
// Delete per-session states not touched for SESSION_TTL_DAYS. Best effort.
export function pruneSessions(now = Date.now()) {
  const {dir} = getPaths(process.cwd(), 'x');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const f = path.join(dir, n);
    try { if (now - fs.statSync(f).mtimeMs > SESSION_TTL_DAYS * 864e5) fs.unlinkSync(f); } catch {}
  }
}
function initial(cwd, session='') { return {version: 1, project: path.resolve(cwd), ...(session ? {session} : {}), enabled: true, goal: '', items: []}; }
export function load(cwd = process.cwd(), session = '') {
  const {file} = getPaths(cwd, session);
  if (!fs.existsSync(file)) return initial(cwd, session);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(raw.items)) throw new Error('Invalid consensus state: items must be an array');
  return raw;
}
export function save(state, cwd=process.cwd(), session='') {
  const {file} = getPaths(cwd, session);
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state,null,2)+'\n', {mode: 0o600});
  fs.renameSync(tmp,file);
}
export function summary(state) {
  return `Consensus: ${state.enabled ? 'ON' : 'OFF'}\nGoal: ${state.goal || '(not yet agreed)'}\n${state.items.length ? state.items.map((x,i)=>`${i+1}. [${x.status}] ${x.text}`).join('\n') : 'No consensus items yet.'}`;
}
function fail(message){console.error(message);process.exit(1)}
// Text is the remaining args joined, or stdin when the only arg is "-".
// Claude passes user wording through a quoted heredoc (<<'EOF') so the shell never expands $(...) or backticks in it.
function textOf(words){
  if (words.length===1 && words[0]==='-') { try { return fs.readFileSync(0,'utf8').trim(); } catch { return ''; } }
  return words.join(' ').trim();
}
// Accept a full id or a unique prefix of at least 4 characters (the hook shows the first 8).
export function findItem(state, ref) {
  if (!ref) return {error: 'Missing item id.'};
  const exact = state.items.find(x => x.id === ref);
  if (exact) return {item: exact};
  if (ref.length < 4) return {error: 'Item id prefix must be at least 4 characters.'};
  const matches = state.items.filter(x => x.id.startsWith(ref));
  if (matches.length === 1) return {item: matches[0]};
  if (matches.length > 1) return {error: `Ambiguous id ${ref}: matches ${matches.map(x => x.id.slice(0, 12)).join(', ')}. Use a longer prefix.`};
  return {error: 'Unknown item id. Run status-json'};
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [command,...args] = process.argv.slice(2);
  const cwd = resolveProject(process.cwd());
  // CONSENSUS_SESSION selects a per-session state (set by the hook in the home folder); on/off always applies to the folder.
  const session = process.env.CONSENSUS_SESSION || '';
  let folder, state;
  try {folder=load(cwd); state=session?load(cwd,session):folder;} catch(e){fail(e.message)}
  const on=folder.enabled;
  // Who made the change: the Consensus viewer sets CONSENSUS_BY=user, everything else is Claude.
  const by = process.env.CONSENSUS_BY === 'user' ? 'user' : 'claude';
  const log = ev => { state.events = [...(state.events || []), {at: Date.now(), by, ...ev}].slice(-30); };
  if (command==='on' || command==='off') {folder.enabled=command==='on'; save(folder,cwd); console.log(`Consensus Harness ${command.toUpperCase()} for ${cwd}`);}
  else if (command==='status' || !command){console.log(summary({...state,enabled:on}));}
  else if (command==='goal') {if(!on) fail('Harness is off.'); const text=textOf(args);if(!text)fail('Usage: goal <text|->');state.goal=text;save(state,cwd,session);console.log('Goal updated.');}
  else if (command==='add') {if(!on)fail('Harness is off.');const [status,...words]=args;const text=textOf(words);if(!['agreed','assumed','open','rejected'].includes(status)||!text)fail('Usage: add <agreed|assumed|open|rejected> <text|->');if(state.items.some(x=>x.text.toLowerCase()===text.toLowerCase()))fail('Duplicate item');const now=Date.now(),id=crypto.randomUUID();state.items.push({id,status,text,at:now,updated:now,by});log({action:'add',id,status,text});save(state,cwd,session);console.log('Item added.');}
  else if (command==='edit') {if(!on)fail('Harness is off.');const [id,status,...words]=args;const text=textOf(words);if(!id||!['agreed','assumed','open','rejected'].includes(status)||!text)fail('Usage: edit <id> <status> <text|->');const {item,error}=findItem(state,id);if(error)fail(error);const was=item.status;item.status=status;item.text=text;item.updated=Date.now();item.by=by;log({action:'edit',id:item.id,status,was,text});save(state,cwd,session);console.log('Item updated.');}
  else if (command==='gist') {if(!on)fail('Harness is off.');const text=textOf(args);if(!text)fail('Usage: gist <text|->');state.gist=text;save(state,cwd,session);console.log('Gist updated.');}
  else if (command==='note') {if(!on)fail('Harness is off.');const [id,...words]=args;const text=textOf(words);if(!id||!text)fail('Usage: note <id> <text|->');const {item,error}=findItem(state,id);if(error)fail(error);item.notes=[...(item.notes||[]),{at:Date.now(),by,text}];item.updated=Date.now();log({action:'note',id:item.id,status:item.status,text:item.text,note:text});save(state,cwd,session);console.log('Note added.');}
  else if (command==='remove') {if(!on)fail('Harness is off.');const {item,error}=findItem(state,args[0]);if(error)fail(error);state.items=state.items.filter(x=>x!==item);log({action:'remove',id:item.id,status:item.status,text:item.text});save(state,cwd,session);console.log('Item removed.');}
  else if(command==='status-json'){console.log(JSON.stringify(state,null,2));}
  else fail(`Unknown command: ${command}`);
}
