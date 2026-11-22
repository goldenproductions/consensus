import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {load, resolveProject, isSharedDir, pruneSessions, getPaths} from './state.mjs';
import {archive, migrateFolderState, renderMemory} from './memory.mjs';
const chunks=[];
for await (const chunk of process.stdin) chunks.push(chunk);
let input={};
try { input=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'); } catch {process.exit(0)}
const event=input.hook_event_name || 'UserPromptSubmit';
const project=resolveProject(input.cwd || process.cwd());
// Every session has its own working consensus; the project keeps a compacted long-term memory of past sessions.
const session=input.session_id ? String(input.session_id) : '';
let state;
try {
  const folder=load(project);
  if(!folder.enabled)process.exit(0);
  state=session?load(project,session):folder;
} catch {process.exit(0)}
if(session && event==='SessionStart') pruneSessions();
// Keep this session's memory episode current (on every prompt and at the end), so nothing has to be saved by hand.
if(session){ try{ archive(project,session,state); }catch{} }
if(event==='SessionEnd') process.exit(0);
let memory='';
if(event==='SessionStart'){ try{ migrateFolderState(project); memory=renderMemory(project,session); }catch{} }

// Agreed first, then open, then assumed (stable within each); cap the list and say what was left out.
const MAX_ITEMS=15;
// Rejected right after agreed: a "no" must stay in view so Claude doesn't propose it again.
const rank={agreed:0,rejected:1,open:2,assumed:3};
const ordered=state.items.map((x,i)=>[x,i]).sort((a,b)=>(rank[a[0].status]??3)-(rank[b[0].status]??3)||a[1]-b[1]).map(([x])=>x);
// Agreed and rejected items are binding, so they are always shown; the cap only trims open and assumed ones.
const binding=ordered.filter(x=>x.status==='agreed'||x.status==='rejected');
const rest=ordered.filter(x=>!binding.includes(x));
const shown=[...binding,...rest.slice(0,Math.max(0,MAX_ITEMS-binding.length))];
const hidden=ordered.filter(x=>!shown.includes(x));
const counts=['agreed','rejected','open','assumed'].map(st=>[st,hidden.filter(x=>x.status===st).length]).filter(([,n])=>n).map(([st,n])=>`${n} ${st}`).join(', ');
const noteLines=x=>(x.notes||[]).map(n=>`\n    ↳ ${n.by==='user'?'user note':'note'}: ${n.text}`).join('');
const brief=shown.map(x=>`- ${x.status.toUpperCase()}${x.by==='user'?' (set by the user in the viewer)':''} {${x.topic||'no topic'}} [${x.id.slice(0,8)}]: ${x.text}${noteLines(x)}`).join('\n')
  +(hidden.length?`\n- +${hidden.length} more not shown (${counts}); run status-json to see them`:'');
// Pin the project explicitly so the CLI hits the same state file even if the shell has cd'd elsewhere.
const cli=`CONSENSUS_PROJECT="${project}"${session?` CONSENSUS_SESSION="${session}"`:''} node "${process.env.CLAUDE_PLUGIN_ROOT || ''}/scripts/state.mjs"`;
const usage=`State manager, run via Bash as: ${cli} <command>
Commands: goal - | gist - | add <agreed|assumed|open> --topic "<Topic>" - | edit <id> <agreed|assumed|open|rejected> - | topic <id> "<Topic>" | remove <id> | status-json (full state). <id> is the short id in brackets above or the full id.
"-" reads the text from stdin. Always pass text through a quoted heredoc so the shell never expands the user's words, e.g.:
${cli} add agreed - <<'EOF'
<text>
EOF`;
const scope=session?(isSharedDir(project)?' (this session; started in the home folder)':' (this session)'):'';
const current=`Current goal${scope}: ${state.goal || '(not yet agreed)'}\n${brief || 'No consensus recorded yet.'}`;

const guidance=`Consensus Harness is enabled for this project. Conversational working agreement:
- Answer short and precise. Your FIRST line is what you need from the user (a decision, an answer, an action); if you need nothing, the first line is the answer itself. Then only what they must know: result, risk, anything that changes their decision. No recaps, process narration or lists of what you checked unless asked or it matters. Aim for under ~120 words unless the user asks for depth.
- First identify the user's objective; if ambiguous, ask only one essential question.
- Usually offer your best short, intuitive recommendation rather than exhaustive options.
- Present one idea or decision at a time; expand only when requested.
- Do not force a question after every reply.
- Distinguish agreed facts from your assumptions; never claim agreement without evidence from the user's words.
- When user explicitly agrees or changes a decision, update shared state via the state manager below if tools are available. Never change agreed status based solely on your own suggestion.
- A general yes ("sounds good", "go with your suggestion") agrees only to your main recommendation. Save details the user did not name as assumed, not agreed. Write agreed items and the goal in the user's own words; do not add detail they did not state.
- Do not perform major coding actions that contradict agreed items without discussing it first.
- Write item text as the plain decision or question. Never put status words like "Proposed:" or "(not agreed)" in the text: the status already says it, and the user can change the status in the viewer.
- REJECTED items: the user said no. Do not act on them or propose them again; if you need something in their place, propose an alternative. A user note under it usually says why.
- "user note" lines under an item are the user's follow-ups or constraints, often a partial agreement: respect them, adjust the item or your plan, and answer any question in them. Keep the item's status unless the user changed it.
- Items marked "set by the user in the viewer" were changed by the user directly in the Consensus viewer. They are the user's explicit decision: do not revert them, do not ask about them again, act on them.
- Give every item a short topic (1-2 words, like "Viewer" or "Memory") with --topic; the viewer groups items by it. Reuse the topic names shown in braces; start a new topic when the conversation moves to a new subject. Give items marked {no topic} one with the topic command when you touch them.
- Keep a gist: 1-3 lines on the overall consensus (the direction, not details), set with "gist -". Update it when the direction changes, not every turn. It is what future sessions in this project will remember; saving is automatic.
- The user may disable this harness; do not override this.
- Before using the unslop skill, load the consensus skill: it says how to reuse and record the UI direction.`;

// Announce what the user changed in the viewer since this session's previous prompt, so Claude doesn't re-ask or revert it.
let notice='';
const sid=String(input.session_id||'');
if(sid){
  const seenFile=path.join(getPaths(project).root,'seen',crypto.createHash('sha256').update(`${project}\0${sid}`).digest('hex').slice(0,20)+'.json');
  let last=null;
  try{last=JSON.parse(fs.readFileSync(seenFile,'utf8')).at}catch{}
  const now=Date.now();
  if(last!==null){
    const evs=(state.events||[]).filter(e=>e.by==='user'&&e.at>last);
    if(evs.length){
      const line=e=>e.action==='note'?`- note on [${e.id.slice(0,8)}] (${e.status}) "${e.text}": ${e.note}`:e.action==='remove'?`- removed [${e.id.slice(0,8)}]: ${e.text}`:e.action==='add'?`- added as ${e.status.toUpperCase()} [${e.id.slice(0,8)}]: ${e.text}`:`- [${e.id.slice(0,8)}] ${e.was?e.was+' → ':''}${e.status.toUpperCase()}: ${e.text}`;
      notice=`\nChanged by the user in the Consensus viewer since your last reply. These are the user's own decisions: acknowledge them briefly if relevant, act on them, and do not ask about them again or revert them:\n${evs.map(line).join('\n')}`;
    }
  }
  try{fs.mkdirSync(path.dirname(seenFile),{recursive:true,mode:0o700});fs.writeFileSync(seenFile,JSON.stringify({at:now}),{mode:0o600});}catch{}
}

// Full guidance once per session start (also fires after /clear and compaction); per prompt only the live state.
const context = event==='SessionStart'
  ? `${guidance}\n${memory?memory+'\n':''}${current}${notice}\n${usage}`
  : `Consensus Harness (on). Reply short (~120 words max). First line: what you need from the user (or the answer). Other detail only if it matters.\n${current}${notice}\n${usage}`;
console.log(JSON.stringify({hookSpecificOutput:{hookEventName:event,additionalContext:context}}));
