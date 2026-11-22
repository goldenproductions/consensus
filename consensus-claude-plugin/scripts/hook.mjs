import {load, resolveProject, isSharedDir, pruneSessions} from './state.mjs';
const chunks=[];
for await (const chunk of process.stdin) chunks.push(chunk);
let input={};
try { input=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'); } catch {process.exit(0)}
const event=input.hook_event_name || 'UserPromptSubmit';
const project=resolveProject(input.cwd || process.cwd());
// In the home folder each session gets its own consensus; elsewhere the folder (git root) owns it.
const session=isSharedDir(project) && input.session_id ? String(input.session_id) : '';
let state;
try {
  const folder=load(project);
  if(!folder.enabled)process.exit(0);
  state=session?load(project,session):folder;
} catch {process.exit(0)}
if(session && event==='SessionStart') pruneSessions();

// Agreed first, then open, then assumed (stable within each); cap the list and say what was left out.
const MAX_ITEMS=15;
const rank={agreed:0,open:1,assumed:2};
const ordered=state.items.map((x,i)=>[x,i]).sort((a,b)=>(rank[a[0].status]??3)-(rank[b[0].status]??3)||a[1]-b[1]).map(([x])=>x);
const hidden=ordered.slice(MAX_ITEMS);
const counts=['agreed','open','assumed'].map(st=>[st,hidden.filter(x=>x.status===st).length]).filter(([,n])=>n).map(([st,n])=>`${n} ${st}`).join(', ');
const brief=ordered.slice(0,MAX_ITEMS).map(x=>`- ${x.status.toUpperCase()} [${x.id.slice(0,8)}]: ${x.text}`).join('\n')
  +(hidden.length?`\n- +${hidden.length} more not shown (${counts}); run status-json to see them`:'');
// Pin the project explicitly so the CLI hits the same state file even if the shell has cd'd elsewhere.
const cli=`CONSENSUS_PROJECT="${project}"${session?` CONSENSUS_SESSION="${session}"`:''} node "${process.env.CLAUDE_PLUGIN_ROOT || ''}/scripts/state.mjs"`;
const usage=`State manager, run via Bash as: ${cli} <command>
Commands: goal - | add <agreed|assumed|open> - | edit <id> <agreed|assumed|open> - | remove <id> | status-json (full state). <id> is the short id in brackets above or the full id.
"-" reads the text from stdin. Always pass text through a quoted heredoc so the shell never expands the user's words, e.g.:
${cli} add agreed - <<'EOF'
<text>
EOF`;
const scope=session?' (scoped to this session: started in the home folder, not a project)':'';
const current=`Current goal${scope}: ${state.goal || '(not yet agreed)'}\n${brief || 'No consensus recorded yet.'}`;

const guidance=`Consensus Harness is enabled for this project. Conversational working agreement:
- First identify the user's objective; if ambiguous, ask only one essential question.
- Usually offer your best short, intuitive recommendation rather than exhaustive options.
- Present one idea or decision at a time; expand only when requested.
- Do not force a question after every reply.
- Distinguish agreed facts from your assumptions; never claim agreement without evidence from the user's words.
- When user explicitly agrees or changes a decision, update shared state via the state manager below if tools are available. Never change agreed status based solely on your own suggestion.
- A general yes ("sounds good", "go with your suggestion") agrees only to your main recommendation. Save details the user did not name as assumed, not agreed. Write agreed items and the goal in the user's own words; do not add detail they did not state.
- Do not perform major coding actions that contradict agreed items without discussing it first.
- The user may disable this harness; do not override this.
- Before using the unslop skill, load the consensus skill: it says how to reuse and record the UI direction.`;

// Full guidance once per session start (also fires after /clear and compaction); per prompt only the live state.
const context = event==='SessionStart'
  ? `${guidance}\n${current}\n${usage}`
  : `Consensus Harness (on). ${current}\n${usage}`;
console.log(JSON.stringify({hookSpecificOutput:{hookEventName:event,additionalContext:context}}));
