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
function projectKey(cwd) { return crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 20); }
export function getPaths(cwd = process.cwd()) {
  const root = process.env.CONSENSUS_HOME || path.join(os.homedir(), '.consensus-harness');
  return {root, file: path.join(root, 'projects', `${projectKey(cwd)}.json`)};
}
function initial(cwd) { return {version: 1, project: path.resolve(cwd), enabled: true, goal: '', items: []}; }
export function load(cwd = process.cwd()) {
  const {file} = getPaths(cwd);
  if (!fs.existsSync(file)) return initial(cwd);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(raw.items)) throw new Error('Invalid consensus state: items must be an array');
  return raw;
}
export function save(state, cwd=process.cwd()) {
  const {file} = getPaths(cwd);
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state,null,2)+'\n', {mode: 0o600});
  fs.renameSync(tmp,file);
}
export function summary(state) {
  return `Consensus: ${state.enabled ? 'ON' : 'OFF'}\nGoal: ${state.goal || '(not yet agreed)'}\n${state.items.length ? state.items.map((x,i)=>`${i+1}. [${x.status}] ${x.text}`).join('\n') : 'No consensus items yet.'}`;
}
function fail(message){console.error(message);process.exit(1)}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [command,...args] = process.argv.slice(2);
  const cwd = resolveProject(process.cwd());
  let state;
  try {state=load(cwd);} catch(e){fail(e.message)}
  if (command==='on' || command==='off') {state.enabled=command==='on'; save(state,cwd); console.log(`Consensus Harness ${command.toUpperCase()} for ${cwd}`);}
  else if (command==='status' || !command){console.log(summary(state));}
  else if (command==='goal') {if(!state.enabled) fail('Harness is off.'); if(!args.join(' ').trim())fail('Usage: goal <text>');state.goal=args.join(' ').trim();save(state,cwd);console.log('Goal updated.');}
  else if (command==='add') {if(!state.enabled)fail('Harness is off.');const [status,...words]=args;if(!['agreed','assumed','open'].includes(status)||!words.join(' ').trim())fail('Usage: add <agreed|assumed|open> <text>');const text=words.join(' ').trim();if(state.items.some(x=>x.text.toLowerCase()===text.toLowerCase()))fail('Duplicate item');state.items.push({id:crypto.randomUUID(),status,text});save(state,cwd);console.log('Item added.');}
  else if (command==='edit') {if(!state.enabled)fail('Harness is off.');const [id,status,...words]=args;if(!id||!['agreed','assumed','open'].includes(status)||!words.join(' ').trim())fail('Usage: edit <id> <status> <text>');const item=state.items.find(x=>x.id===id);if(!item)fail('Unknown item id. Run status-json');item.status=status;item.text=words.join(' ').trim();save(state,cwd);console.log('Item updated.');}
  else if (command==='remove') {if(!state.enabled)fail('Harness is off.');const old=state.items.length;state.items=state.items.filter(x=>x.id!==args[0]);if(old===state.items.length)fail('Unknown item id.');save(state,cwd);console.log('Item removed.');}
  else if(command==='status-json'){console.log(JSON.stringify(state,null,2));}
  else fail(`Unknown command: ${command}`);
}
