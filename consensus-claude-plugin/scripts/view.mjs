#!/usr/bin/env node
// Open the Consensus viewer (viz/brain.mjs) beside the chat: a split pane where the terminal allows it
// (herdr, tmux, WezTerm, Windows Terminal, iTerm2), else a new window (Terminal.app, a Windows console),
// else print the command to run. Always prints that command, so the user can start it by hand too.
//
//   node view.mjs [--print] [viewer options, e.g. --project <dir> --no-mesh]
//
// --print only prints the command.
// CONSENSUS_VIEW=print|herdr|tmux|wezterm|wt|iterm|terminal|console forces a method.
import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const BRAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'viz', 'brain.mjs');
const NODE = process.execPath;
const args = process.argv.slice(2);
const printOnly = args.includes('--print');
const viewerArgs = args.filter(a => a !== '--print');
const cwd = process.cwd();
const env = process.env;
const isWin = process.platform === 'win32';

const q = s => isWin ? (/[\s"&|<>^;]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s)
                     : (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const command = [NODE, BRAIN, ...viewerArgs].map(q).join(' ');
const shortCommand = ['node', BRAIN, ...viewerArgs].map(q).join(' ');

if (!fs.existsSync(BRAIN)) {
  console.error(`Consensus viewer not found at ${BRAIN}. Reinstall the consensus plugin.`);
  process.exit(1);
}

function has(cmd) {
  const r = spawnSync(isWin ? 'where' : 'which', [cmd], {stdio: 'ignore'});
  return r.status === 0;
}

function detached(cmd, argv, verbatim = false) {
  try {
    const p = spawn(cmd, argv, {cwd, detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: verbatim});
    p.on('error', () => {});
    p.unref();
    return true;
  } catch { return false; }
}

function run(cmd, argv) {
  const r = spawnSync(cmd, argv, {cwd, stdio: 'ignore'});
  return !r.error && r.status === 0;
}

const osa = s => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const shellLine = `cd ${q(cwd)} && ${command}`;

// herdr: split the agent's own pane, then type the command into the new pane's shell.
function herdr() {
  const bin = env.HERDR_BIN_PATH || 'herdr';
  const r = spawnSync(bin, ['pane', 'split', '--pane', env.HERDR_PANE_ID, '--direction', 'right', '--ratio', '0.55', '--cwd', cwd, '--no-focus'], {encoding: 'utf8'});
  if (r.error || r.status !== 0) return false;
  let id;
  try { id = JSON.parse(r.stdout).result.pane.pane_id; } catch { return false; }
  return run(bin, ['pane', 'run', id, shortCommand]);
}

// Each method: [name, applies?, open() -> true on success, where it opened]
const methods = [
  ['herdr', () => !!env.HERDR_PANE_ID, herdr, 'a herdr pane on the right'],
  ['tmux', () => !!env.TMUX && has('tmux'),
    () => run('tmux', ['split-window', '-h', '-l', '45%', '-c', cwd, NODE, BRAIN, ...viewerArgs]), 'a tmux pane on the right'],
  ['wezterm', () => !!env.WEZTERM_PANE && has('wezterm'),
    () => run('wezterm', ['cli', 'split-pane', '--right', '--percent', '45', '--cwd', cwd, '--', NODE, BRAIN, ...viewerArgs]), 'a WezTerm pane on the right'],
  ['wt', () => isWin && !!env.WT_SESSION,
    () => detached('wt.exe', ['-w', '0', 'split-pane', '-V', '-s', '0.45', '-d', cwd, '--title', 'Consensus', NODE, BRAIN, ...viewerArgs]), 'a Windows Terminal pane on the right'],
  ['iterm', () => process.platform === 'darwin' && env.TERM_PROGRAM === 'iTerm.app',
    () => run('osascript', ['-e', `tell application "iTerm2" to tell current session of current window to tell (split vertically with default profile) to write text "${osa(shellLine)}"`]), 'an iTerm2 pane on the right'],
  ['terminal', () => process.platform === 'darwin',
    () => run('osascript', ['-e', `tell application "Terminal" to do script "${osa(shellLine)}"`, '-e', 'tell application "Terminal" to activate']), 'a new Terminal window'],
  ['console', () => isWin,
    () => detached('cmd.exe', ['/d', '/s', '/c', `"start "Consensus" /d ${q(cwd)} ${command}"`], true), 'a new console window'],
];

const forced = (env.CONSENSUS_VIEW || '').toLowerCase();
let opened = null;
if (!printOnly && forced !== 'print') {
  for (const [name, applies, open, where] of methods) {
    if (forced ? forced !== name : !applies()) continue;
    if (open()) { opened = where; break; }
  }
}

if (opened) console.log(`Opened the Consensus viewer in ${opened}.`);
else if (!printOnly && forced !== 'print') console.log('Could not open a pane from here. Run this in a terminal beside the chat:');
else console.log('Run this in a terminal beside the chat:');
console.log(opened ? `To open it by hand: ${shortCommand}` : `  ${shortCommand}`);
