import {load, resolveProject} from './state.mjs';
const chunks=[];
for await (const chunk of process.stdin) chunks.push(chunk);
let input={};
try { input=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'); } catch {process.exit(0)}
const event=input.hook_event_name || 'UserPromptSubmit';
const project=resolveProject(input.cwd || process.cwd());
let state;
try {state=load(project)} catch {process.exit(0)}
if(!state.enabled)process.exit(0);

const brief=state.items.slice(0,15).map(x=>`- ${x.status.toUpperCase()} [${x.id.slice(0,8)}]: ${x.text}`).join('\n');
// Pin the project explicitly so the CLI hits the same state file even if the shell has cd'd elsewhere.
const cli=`CONSENSUS_PROJECT="${project}" node "${process.env.CLAUDE_PLUGIN_ROOT || ''}/scripts/state.mjs"`;
const usage=`State manager, run via Bash as: ${cli} <command>
Commands: goal "<text>" | add <agreed|assumed|open> "<text>" | edit <full-id> <agreed|assumed|open> "<text>" | remove <full-id> | status-json (lists full ids)`;
const current=`Current goal: ${state.goal || '(not yet agreed)'}\n${brief || 'No consensus recorded yet.'}`;

const guidance=`Consensus Harness is enabled for this project. Conversational working agreement:
- First identify the user's objective; if ambiguous, ask only one essential question.
- Usually offer your best short, intuitive recommendation rather than exhaustive options.
- Present one idea or decision at a time; expand only when requested.
- Do not force a question after every reply.
- Distinguish agreed facts from your assumptions; never claim agreement without evidence from the user's words.
- When user explicitly agrees or changes a decision, update shared state via the state manager below if tools are available. Never change agreed status based solely on your own suggestion.
- Do not perform major coding actions that contradict agreed items without discussing it first.
- The user may disable this harness; do not override this.
- Working with the unslop skill: before proposing an unslop direction, check the agreed items for an existing "UI direction" and build on it instead of inventing a new one. When the user confirms unslop's direction (product, character, world, moments, signature), save it as one agreed item "UI direction: <the five lines, condensed>" and the audit's heavy/light/no-slop verdict as assumed. Edit that item, don't add a second one, if the direction changes later.`;

// Full guidance once per session start (also fires after /clear and compaction); per prompt only the live state.
const context = event==='SessionStart'
  ? `${guidance}\n${current}\n${usage}`
  : `Consensus Harness (on). ${current}\n${usage}`;
console.log(JSON.stringify({hookSpecificOutput:{hookEventName:event,additionalContext:context}}));
