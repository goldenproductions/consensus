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
  const cur = state.items.filter(x => isCurrent(state, x)), earlier = state.goals || [];
  return `Consensus: ${state.enabled ? 'ON' : 'OFF'}\nGoal: ${state.goal || '(not yet agreed)'}\nWhy: ${state.why || '(not yet agreed)'}\n${cur.length ? cur.map((x,i)=>`${i+1}. [${x.status}${x.first ? ', ask first' : ''}${x.done ? ', done' : ''}] ${x.text}${x.done?.note ? ` (done: ${x.done.note})` : ''}`).join('\n') : 'No consensus items yet.'}${earlier.length ? `\nEarlier goals: ${earlier.map(g => `"${g.goal || '(none)'}" (${state.items.filter(x => x.goal === g.id).length} items)`).join(', ')}` : ''}`;
}
function fail(message){console.error(message);process.exit(1)}
// Text is the remaining args joined, or stdin when the only arg is "-".
// Claude passes user wording through a quoted heredoc (<<'EOF') so the shell never expands $(...) or backticks in it.
function textOf(words){
  if (words.length===1 && words[0]==='-') { try { return fs.readFileSync(0,'utf8').replace(/^\uFEFF/,'').replace(/\r\n/g,'\n').trim(); } catch { return ''; } } // PowerShell pipes may add a BOM and CRLF
  return words.join(' ').trim();
}
// When this session last got the consensus (its last prompt, or the last auto-wake): viewer changes after it are new to the AI.
export function seenFile(project, session) {
  return path.join(getPaths(project).root, 'seen', crypto.createHash('sha256').update(`${project}\0${session}`).digest('hex').slice(0, 20) + '.json');
}
export function readSeen(project, session) { try { return JSON.parse(fs.readFileSync(seenFile(project, session), 'utf8')).at; } catch { return null; } }
export function markSeen(project, session, at = Date.now()) {
  try { const f = seenFile(project, session); fs.mkdirSync(path.dirname(f), {recursive: true, mode: 0o700}); fs.writeFileSync(f, JSON.stringify({at}), {mode: 0o600}); } catch {}
}
// Goals: the current goal is state.goal/why (id state.goalId); earlier goals are filed in state.goals, oldest first.
// Each item carries the id of the goal it was made under; an item without one belongs to the current goal.
export const isCurrent = (state, x) => !x.goal || x.goal === state.goalId;
// Start a new goal: file the current one (with the items that have no goal yet) and begin an empty one.
export function newGoal(state, text, now = Date.now()) {
  const hadGoal = !!(state.goal || state.items.length);
  if (hadGoal) {
    const id = state.goalId || crypto.randomUUID();
    const started = state.goalAt || Math.min(...state.items.map(x => x.at || now), now);
    state.goals = [...(state.goals || []), {id, goal: state.goal || '', ...(state.why ? {why: state.why} : {}), at: started, ended: now}];
    for (const x of state.items) if (!x.goal) x.goal = id;
  }
  state.goalId = crypto.randomUUID(); state.goal = text; state.goalAt = now;
  delete state.why; delete state.go; delete state.working;
  return hadGoal;
}
// One line per viewer change, as the AI is told about it.
export function eventLine(e) {
  const id = String(e.id || '').slice(0, 8);
  if (e.action === 'go') return `- said GO: proceed on your recommended answers${e.text ? ` to: ${e.text}` : ''}; record them as assumed and do not ask these again`;
  if (e.action === 'why') return `- set the why: ${e.text}`;
  if (e.action === 'note') return `- note on [${id}] (${e.status}) "${e.text}": ${e.note}`;
  if (e.action === 'remove') return `- removed [${id}]: ${e.text}`;
  if (e.action === 'done') return `- marked [${id}] done: ${e.text}${e.note ? ` (${e.note})` : ''}`;
  if (e.action === 'undone') return `- marked [${id}] not done, the work is not finished: ${e.text}`;
  if (e.action === 'goal') return `- started a new goal: ${e.text}${e.was ? ` (the earlier goal "${e.was}" and its decisions are kept)` : ''}`;
  if (e.action === 'add') return `- added as ${String(e.status).toUpperCase()} [${id}]: ${e.text}`;
  return `- [${id}] ${e.was ? e.was + ' → ' : ''}${String(e.status).toUpperCase()}: ${e.text}`;
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
  const [command,...rawArgs] = process.argv.slice(2);
  // --topic <name> may appear anywhere: a short subject (1-2 words) that groups items into segments.
  const ti = rawArgs.indexOf('--topic');
  const topicArg = ti < 0 ? undefined : String(rawArgs[ti + 1] || '').trim();
  // --first marks an open question to settle before building (the soft clarify gate).
  const firstArg = rawArgs.includes('--first');
  const args = (ti < 0 ? rawArgs : rawArgs.filter((_, j) => j !== ti && j !== ti + 1)).filter(a => a !== '--first');
  const cwd = resolveProject(process.cwd());
  // CONSENSUS_SESSION selects a per-session state (set by the hook in the home folder); on/off always applies to the folder.
  const session = process.env.CONSENSUS_SESSION || '';
  let folder, state;
  try {folder=load(cwd); state=session?load(cwd,session):folder;} catch(e){fail(e.message)}
  const on=folder.enabled;
  // Who made the change: the Consensus viewer sets CONSENSUS_BY=user, everything else is Claude.
  const by = process.env.CONSENSUS_BY === 'user' ? 'user' : 'claude';
  const log = ev => { state.events = [...(state.events || []), {at: Date.now(), by, ...ev}].slice(-30); };
  if (command==='on' || command==='off') {folder.enabled=command==='on'; save(folder,cwd); console.log(`Consensus ${command.toUpperCase()} for ${cwd}`);}
  else if (command==='status' || !command){console.log(summary({...state,enabled:on}));}
  // goal -: reword the current goal. goal --new -: the work moved on; file the current goal with its items, start a new one.
  else if (command==='goal') {if(!on) fail('Consensus is off.');const isNew=args.includes('--new');const text=textOf(args.filter(a=>a!=='--new'));if(!text)fail('Usage: goal [--new] <text|->');
    if(isNew){const was=state.goal||'';const filed=newGoal(state,text);log({action:'goal',text,was});save(state,cwd,session);console.log(filed?`New goal. The earlier goal and its items are kept; its agreed and rejected decisions still apply.`:'Goal set.');}
    else{state.goal=text;if(!state.goalId){state.goalId=crypto.randomUUID();state.goalAt=Date.now();}save(state,cwd,session);console.log('Goal updated.');}}
  else if (command==='add') {if(!on)fail('Consensus is off.');const [status,...words]=args;const text=textOf(words);if(!['agreed','assumed','open','rejected'].includes(status)||!text)fail('Usage: add <agreed|assumed|open|rejected> <text|->');if(state.items.some(x=>x.text.toLowerCase()===text.toLowerCase()))fail('Duplicate item');const now=Date.now(),id=crypto.randomUUID();state.items.push({id,status,text,at:now,updated:now,by,...(state.goalId?{goal:state.goalId}:{}),...(topicArg?{topic:topicArg}:{}),...(firstArg&&status==='open'?{first:true}:{})});log({action:'add',id,status,text});save(state,cwd,session);console.log('Item added.');}
  else if (command==='edit') {if(!on)fail('Consensus is off.');const [id,status,...words]=args;const text=textOf(words);if(!id||!['agreed','assumed','open','rejected'].includes(status)||!text)fail('Usage: edit <id> <status> <text|->');const {item,error}=findItem(state,id);if(error)fail(error);const was=item.status;item.status=status;if(!['agreed','assumed'].includes(status))delete item.done;item.text=text;item.updated=Date.now();item.by=by;if(topicArg!==undefined)item.topic=topicArg;if(status!=='open')delete item.first;else if(firstArg)item.first=true;log({action:'edit',id:item.id,status,was,text});save(state,cwd,session);console.log('Item updated.');}
  else if (command==='retopic') {if(!on)fail('Consensus is off.');const from=String(args[0]||'').trim(),to=args.slice(1).join(' ').trim();if(!from||!to)fail('Usage: retopic <old> <new>');const hit=state.items.filter(x=>(x.topic||'').toLowerCase()===from.toLowerCase());if(!hit.length)fail(`No items with topic ${from}`);for(const x of hit)x.topic=to;save(state,cwd,session);console.log(`Moved ${hit.length} item(s) from ${from} to ${to}.`);}
  else if (command==='topic') {if(!on)fail('Consensus is off.');const [id,...words]=args;const text=textOf(words);if(!id||!text)fail('Usage: topic <id> <name|->');const {item,error}=findItem(state,id);if(error)fail(error);item.topic=text;save(state,cwd,session);console.log('Topic set.');}
  else if (command==='why') {if(!on)fail('Consensus is off.');const text=textOf(args);if(!text)fail('Usage: why <text|->');state.why=text;log({action:'why',text});save(state,cwd,session);console.log('Why updated.');}
  else if (command==='go') {if(!on)fail('Consensus is off.');const firsts=state.items.filter(x=>x.first);for(const x of firsts)delete x.first;state.go=Date.now();log({action:'go',text:firsts.map(x=>x.text).join(' | ')});save(state,cwd,session);console.log(`Go: ${firsts.length} question(s) left to your recommendations.`);}
  else if (command==='work') {if(!on)fail('Consensus is off.');const ref=args[0];if(!ref||ref==='none'){delete state.working;save(state,cwd,session);console.log('Not linked to an item.');}else{const {item,error}=findItem(state,ref);if(error)fail(error);state.working={id:item.id,at:Date.now()};save(state,cwd,session);console.log(`Working on [${item.id.slice(0,8)}] (${item.status}). File edits are now linked to it.`);}}
  // done: the work for an agreed (or assumed) item is finished; the optional note says how ("merged in PR #16").
  else if (command==='done' || command==='undone') {if(!on)fail('Consensus is off.');const [id,...words]=args;if(!id)fail(`Usage: ${command} <id>${command==='done'?' [note|-]':''}`);const {item,error}=findItem(state,id);if(error)fail(error);if(command==='done'){if(!['agreed','assumed'].includes(item.status))fail(`Only agreed or assumed items can be done; [${item.id.slice(0,8)}] is ${item.status}.`);const note=textOf(words);item.done={at:Date.now(),by,...(note?{note}:{})};if(state.working?.id===item.id)delete state.working;}else{if(!item.done)fail('That item is not marked done.');delete item.done;}item.updated=Date.now();log({action:command,id:item.id,status:item.status,text:item.text,...(item.done?.note?{note:item.done.note}:{})});save(state,cwd,session);console.log(command==='done'?'Marked done.':'No longer done.');}
  else if (command==='gist') {if(!on)fail('Consensus is off.');const text=textOf(args);if(!text)fail('Usage: gist <text|->');state.gist=text;save(state,cwd,session);console.log('Gist updated.');}
  else if (command==='note') {if(!on)fail('Consensus is off.');const [id,...words]=args;const text=textOf(words);if(!id||!text)fail('Usage: note <id> <text|->');const {item,error}=findItem(state,id);if(error)fail(error);item.notes=[...(item.notes||[]),{at:Date.now(),by,text}];item.updated=Date.now();log({action:'note',id:item.id,status:item.status,text:item.text,note:text});save(state,cwd,session);console.log('Note added.');}
  else if (command==='remove') {if(!on)fail('Consensus is off.');const {item,error}=findItem(state,args[0]);if(error)fail(error);state.items=state.items.filter(x=>x!==item);log({action:'remove',id:item.id,status:item.status,text:item.text});save(state,cwd,session);console.log('Item removed.');}
  else if(command==='status-json'){console.log(JSON.stringify(state,null,2));}
  else fail(`Unknown command: ${command}`);
}
