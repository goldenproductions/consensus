// Play a demo story into a throwaway consensus and capture viewer frames in real time.
// Usage: node capture.mjs <plugin_dir> <work_dir> <cols> <rows>
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const [plugin, work, COLS, ROWS] = process.argv.slice(2);
const HOME = path.join(work, 'home'), PROJ = path.join(work, 'car-gallery'), OUT = path.join(work, 'frames');
for (const d of [HOME, PROJ, OUT]) { fs.rmSync(d, {recursive: true, force: true}); fs.mkdirSync(d, {recursive: true}); }
const ST = path.join(plugin, 'scripts', 'state.mjs'), BRAIN = path.join(plugin, 'viz', 'brain.mjs');
const env = by => ({...process.env, CONSENSUS_HOME: HOME, CONSENSUS_PROJECT: PROJ, ...(by ? {CONSENSUS_BY: by} : {})});
const st = (args, input, by) => execFileSync(process.execPath, [ST, ...args], {cwd: PROJ, env: env(by), input: input ?? '', encoding: 'utf8'});
const SESSION = 'demo';
const actFile = path.join(HOME, 'activity', `${SESSION}.json`);
const activity = (state, label, kind) => { fs.mkdirSync(path.dirname(actFile), {recursive: true}); fs.writeFileSync(actFile, JSON.stringify({session: SESSION, project: PROJ, agent: 'Claude', state, kind, label, steps: 3, at: Date.now()})); };
const idOf = re => JSON.parse(st(['status-json'])).items.find(x => re.test(x.text)).id;

// set up: consensus on, state tied to a session so the viewer shows live activity
st(['on']);
const sfile = path.join(HOME, 'projects', fs.readdirSync(path.join(HOME, 'projects'))[0]);
const s0 = JSON.parse(fs.readFileSync(sfile, 'utf8')); s0.session = SESSION; fs.writeFileSync(sfile, JSON.stringify(s0, null, 2));
activity('thinking', 'thinking', 'think');

let view = {};   // extra viewer flags for the current scene
const timeline = [
  [1000, () => st(['goal', '-'], "A website for our family's classic car photos")],
  [1900, () => st(['why', '-'], "Dad's photos sit on an old hard drive and nobody sees them")],
  [2900, () => st(['add', 'agreed', '--topic', 'Stack', '-'], 'Static site, no backend or database')],
  [3800, () => st(['add', 'agreed', '--topic', 'Content', '-'], 'Photos come from the scanned album folder')],
  [4700, () => st(['add', 'assumed', '--topic', 'Stack', '-'], 'Astro with a simple image grid')],
  [5600, () => st(['add', 'open', '--first', '--topic', 'Audience', '-'], 'Private link for family only, or public?')],
  [6500, () => { st(['add', 'assumed', '--topic', 'Content', '-'], 'Fill gaps with stock car photos'); activity('idle', 'your turn'); }],
  // the user, in the viewer: disagree with stock photos
  [7600, () => { view = {topic: 'Content', select: 1}; }],
  [8700, () => { st(['edit', idOf(/stock/), 'rejected', '-'], 'Fill gaps with stock car photos', 'user'); }],
  // agree to Astro
  [9800, () => { view = {topic: 'Stack', select: 1}; }],
  [10800, () => { st(['edit', idOf(/Astro/), 'agreed', '-'], 'Astro with a simple image grid', 'user'); }],
  // answer the open question
  [11900, () => { view = {topic: 'Audience', select: 1}; }],
  [12900, () => { st(['edit', idOf(/Private link/), 'agreed', '-'], 'Private link, family only', 'user'); }],
  // the AI picks it up and builds on what was agreed
  [14000, () => { view = {}; activity('working', 'editing Gallery.astro', 'edit'); }],
  [16200, () => { activity('working', 'running the dev server', 'run'); }],
];
const END = 18200;

const t0 = Date.now(); let n = 0, next = 0; const times = [];
while (Date.now() - t0 < END) {
  const t = Date.now() - t0;
  while (next < timeline.length && timeline[next][0] <= t) timeline[next++][1]();
  const flags = ['--project', PROJ, '--once', '--size', `${COLS}x${ROWS}`, '--bg', '0d1117'];
  if (view.topic) flags.push('--topic', view.topic);
  if (view.select) flags.push('--select', String(view.select));
  const frame = execFileSync(process.execPath, [BRAIN, ...flags], {env: env(), encoding: 'utf8'});
  fs.writeFileSync(path.join(OUT, String(n++).padStart(4, '0') + '.ans'), frame);
  times.push(Date.now() - t0);
}
fs.writeFileSync(path.join(OUT, 'times.json'), JSON.stringify(times));
console.log(`${n} frames in ${times.at(-1)} ms`);
