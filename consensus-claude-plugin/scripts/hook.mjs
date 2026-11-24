import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {load, resolveProject, isSharedDir, pruneSessions, getPaths, readSeen, markSeen, eventLine, isCurrent} from './state.mjs';
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
// The current goal's items are the working list; earlier goals contribute only what still binds (below).
const curItems=state.items.filter(x=>isCurrent(state,x));
const ordered=curItems.map((x,i)=>[x,i]).sort((a,b)=>(rank[a[0].status]??3)-(rank[b[0].status]??3)||a[1]-b[1]).map(([x])=>x);
// Agreed and rejected items are binding, and the user's own items are their words: always shown.
// The cap only trims Claude's open and assumed items, and the newest few of those always stay in view.
const binding=ordered.filter(x=>x.status==='agreed'||x.status==='rejected'||x.by==='user');
const rest=ordered.filter(x=>!binding.includes(x));
const keep=new Set([...rest].sort((a,b)=>(b.updated||b.at||0)-(a.updated||a.at||0)).slice(0,Math.max(5,MAX_ITEMS-binding.length)));
const shown=ordered.filter(x=>binding.includes(x)||keep.has(x));
const hidden=ordered.filter(x=>!shown.includes(x));
const counts=['agreed','rejected','open','assumed'].map(st=>[st,hidden.filter(x=>x.status===st).length]).filter(([,n])=>n).map(([st,n])=>`${n} ${st}`).join(', ');
const noteLines=x=>(x.notes||[]).map(n=>`\n    ↳ ${n.by==='user'?'user note':'note'}: ${n.text}`).join('');
const workingId=state.working?.id;
const line=x=>`- ${x.status.toUpperCase()}${x.done?` (done${x.done.note?`: ${x.done.note}`:''})`:x.id===workingId?' (you are working on this)':''}${x.first?' (ask first)':''}${x.by==='user'?' (set by the user in the viewer)':''} {${x.topic||'no topic'}} [${x.id.slice(0,8)}]: ${x.text}${noteLines(x)}`;
const brief=shown.map(line).join('\n')
  +(hidden.length?`\n- +${hidden.length} more not shown (${counts}); run status-json to see them`:'');
// Earlier goals: their agreed decisions (not yet done) and rejections still apply; the rest stays in the viewer.
const earlierGoals=(state.goals||[]).map(g=>({g,binding:state.items.filter(x=>x.goal===g.id&&((x.status==='agreed'&&!x.done)||x.status==='rejected'))})).filter(e=>e.binding.length);
const earlierRest=state.items.filter(x=>!isCurrent(state,x)).length-earlierGoals.reduce((a,e)=>a+e.binding.length,0);
const earlier=earlierGoals.length?`\nStill binding from earlier goals:${earlierGoals.map(({g,binding})=>`\n  Earlier goal: ${g.goal||'(none)'}\n${binding.map(x=>'  '+line(x).replace(/\n/g,'\n  ')).join('\n')}`).join('')}${earlierRest>0?`\n  (+${earlierRest} done, open or assumed items under earlier goals; status-json shows them)`:''}`:'';
// Pin the project explicitly so the CLI hits the same state file even if the shell has cd'd elsewhere.
// Commands in the syntax of the shell the agent actually uses: Codex on Windows runs PowerShell, everything else
// (Claude Code everywhere, including its Git Bash on Windows; Codex on Linux/macOS) runs a POSIX shell.
// CONSENSUS_SHELL=powershell|bash overrides the guess.
const stateCli=path.join(path.dirname(fileURLToPath(import.meta.url)),'state.mjs');
const isCodex=/[\\/]\.codex[\\/]/.test(String(input.transcript_path||''))||(process.env.CODEX_HOME&&String(input.transcript_path||'').startsWith(process.env.CODEX_HOME));
const shell=(process.env.CONSENSUS_SHELL||(process.platform==='win32'&&isCodex?'powershell':'bash')).toLowerCase().startsWith('p')?'powershell':'bash';
let usage;
if(shell==='powershell'){
  const q=v=>`'${String(v).replace(/'/g,"''")}'`;
  const env=`$env:CONSENSUS_PROJECT=${q(project)}; ${session?`$env:CONSENSUS_SESSION=${q(session)}; `:''}$OutputEncoding=[Text.Encoding]::UTF8;`;
  const cli=`node ${q(stateCli)}`;
  usage=`State manager, run in PowerShell as: ${env} ${cli} <command>
Commands: goal - | goal --new - | why - | gist - | add <agreed|assumed|open> --topic "<Topic>" [--first] - | go | work <id> | done <id> - | undone <id> | edit <id> <agreed|assumed|open|rejected> - | topic <id> "<Topic>" | retopic "<Old>" "<New>" | remove <id> | status-json (full state). <id> is the short id in brackets above or the full id.
"-" reads the text from stdin. Always pipe the text in from a single-quoted here-string (@' on its own line, '@ at the very start of a line) so PowerShell never expands the user's words, e.g.:
${env} @'
<text>
'@ | ${cli} add agreed -`;
}else{
  const q=v=>`'${String(v).replace(/'/g,"'\\''")}'`;
  const cli=`CONSENSUS_PROJECT=${q(project)}${session?` CONSENSUS_SESSION=${q(session)}`:''} node ${q(stateCli)}`;
  usage=`State manager, run via Bash as: ${cli} <command>
Commands: goal - | goal --new - | why - | gist - | add <agreed|assumed|open> --topic "<Topic>" [--first] - | go | work <id> | done <id> - | undone <id> | edit <id> <agreed|assumed|open|rejected> - | topic <id> "<Topic>" | retopic "<Old>" "<New>" | remove <id> | status-json (full state). <id> is the short id in brackets above or the full id.
"-" reads the text from stdin. Always pass text through a quoted heredoc so the shell never expands the user's words, e.g.:
${cli} add agreed - <<'EOF'
<text>
EOF`;
}const scope=session?(isSharedDir(project)?' (this session; started in the home folder)':' (this session)'):'';
// The topics in use, so new items reuse them instead of each getting its own.
const topicCounts=new Map();for(const x of curItems)if(x.topic)topicCounts.set(x.topic,(topicCounts.get(x.topic)||0)+1);
const topicsLine=topicCounts.size?`\nTopics (reuse one; keep to about 3-6${topicCounts.size>6?`; there are ${topicCounts.size} now, merge related ones with retopic`:''}): ${[...topicCounts].sort((a,b)=>b[1]-a[1]).map(([t,n])=>`${t} ${n}`).join(', ')}`:'';
const current=`Current goal${scope}: ${state.goal || '(not yet agreed)'}\nWhy (the problem it solves): ${state.why || '(not yet agreed)'}\n${brief || 'No consensus recorded yet.'}${earlier}${topicsLine}`;
// Soft clarify gate: while the goal, the why or "ask first" questions are unsettled, push for questions before building. Never blocks.
const firsts=curItems.filter(x=>x.first&&x.status==='open');
// After "go", stop nudging about the goal and why; a new ask-first question turns the nudge back on.
const wentAhead=!!state.go&&!firsts.length;
const missing=[!wentAhead&&!state.goal&&'goal',!wentAhead&&!state.why&&'why',firsts.length&&`${firsts.length} ask-first question${firsts.length>1?'s':''} open`].filter(Boolean);
const clarify=missing.length?`\nCLARIFY FIRST (${missing.join(', ')}): before you spend effort building, check the request is specific enough to build what the user actually wants. If key choices are open (the problem it solves, who it is for, stack, scope, look), do not start building: ask 1-3 short, sharp questions, each with your recommended answer, and record each with add open --first. Answers to them: edit to agreed. Small, clear or easily reversible requests: just do them. Reading and research to ask better questions is fine. If the user says "go", run go and proceed on your recommendations, recording them as assumed.`:'';

const guidance=`Consensus is enabled for this project. Conversational working agreement:
- Answer short and precise. Your FIRST line is what you need from the user (a decision, an answer, an action); if you need nothing, the first line is the answer itself. Then only what they must know: result, risk, anything that changes their decision. No recaps, process narration or lists of what you checked unless asked or it matters. Aim for under ~120 words unless the user asks for depth.
- First identify the user's objective and why they want it; if it is ambiguous, ask the 1-3 questions that matter most, not a questionnaire.
- Usually offer your best short, intuitive recommendation rather than exhaustive options.
- Present one idea or decision at a time; expand only when requested.
- Do not force a question after every reply.
- Distinguish agreed facts from your assumptions; never claim agreement without evidence from the user's words.
- When user explicitly agrees or changes a decision, update shared state via the state manager below if tools are available. Never change agreed status based solely on your own suggestion.
- A general yes ("sounds good", "go with your suggestion") agrees only to your main recommendation. Save details the user did not name as assumed, not agreed. Write agreed items and the goal in the user's own words; do not add detail they did not state.
- Do not perform major coding actions that contradict agreed items without discussing it first.
- Items are decisions, requirements and open questions only. Do not record status reports or progress ("I have deployed it", "tests pass now") as items. Write each item so it still makes sense later without the chat: name what it is about.
- When the work for an item is finished (merged, deployed, verified), run "done <id>" with a short note on how (e.g. "merged in PR #16"). Progress belongs there, on the decision it finishes, not in a new item. Do not mark work done that is still waiting on a review, a merge or a test; "undone <id>" if it turns out unfinished.
- Write item text as the plain decision or question. Never put status words like "Proposed:" or "(not agreed)" in the text: the status already says it, and the user can change the status in the viewer.
- REJECTED items: the user said no. Do not act on them or propose them again; if you need something in their place, propose an alternative. A user note under it usually says why.
- "user note" lines under an item are the user's follow-ups or constraints, often a partial agreement: respect them, adjust the item or your plan, and answer any question in them. Keep the item's status unless the user changed it.
- Items marked "set by the user in the viewer" were changed by the user directly in the Consensus viewer. They are the user's explicit decision: do not revert them, do not ask about them again, act on them.
- Give every item a topic with --topic: a broad area of the work (1-2 words, like "Viewer" or "Memory"), not the subject of one decision. Keep a session to about 3-6 topics: always reuse a topic from the "Topics" line when the item fits one even loosely, and start a new topic only when the conversation moves to a clearly different area. When topics have multiplied, merge them with "retopic <old> <new>". Give items marked {no topic} one with the topic command when you touch them.
- Clarify before building (soft gate): on a vague or open request, think critically and ask before you spend effort guessing. Agree the goal and the why (the problem it solves; set with "why -") first, and ask the 1-3 questions that would most change what you build (e.g. stack, audience, scope), each with your recommendation; record them with add open --first. It is better to ask one sharp question than to build something the user then has to throw away. Do not over-ask: clear, small or easily reversible tasks need no questions. "go" from the user (or GO from the viewer) means proceed on your recommendations; record them as assumed.
- Link your work to the decisions: before you edit files, run "work <id>" with the agreed item the edits carry out (add the item first if none fits), and run it again when the work moves to another item. File edits are then traced to that item, so the user sees which files each decision touched and spots work that is not based on an agreed decision. Do not build on a REJECTED item; building on an open or assumed one is shown to the user as unconfirmed.
- One goal per piece of work. When the conversation clearly moves on to different work than the current goal, propose a new goal in one line; only when the user agrees, run "goal --new -" (the earlier goal and its items are kept, and the user can still look at them in the viewer). Use plain "goal -" only to reword the current goal. Agreed and rejected decisions under earlier goals still apply.
- Keep a gist: 1-3 lines on the overall consensus (the direction, not details), set with "gist -". Update it when the direction changes, not every turn. It is what future sessions in this project will remember; saving is automatic.
- The user may turn this off; do not override this.
- Before using the unslop skill, load the consensus skill: it says how to reuse and record the UI direction.`;

// Announce what the user changed in the viewer since this session's previous prompt, so Claude doesn't re-ask or revert it.
let notice='';
const sid=String(input.session_id||'');
if(sid){
  const last=readSeen(project,sid);
  if(last!==null){
    const evs=(state.events||[]).filter(e=>e.by==='user'&&e.at>last);
    if(evs.length) notice=`\nChanged by the user in the Consensus viewer since your last reply. These are the user's own decisions: acknowledge them briefly if relevant, act on them, and do not ask about them again or revert them:\n${evs.map(eventLine).join('\n')}`;
  }
  markSeen(project,sid);
}

// Full guidance once per session start (also fires after /clear and compaction); per prompt only the live state.
const context = event==='SessionStart'
  ? `${guidance}\n${memory?memory+'\n':''}${current}${notice}${clarify}\n${usage}`
  : `Consensus (on). Reply short (~120 words max). First line: what you need from the user (or the answer). Other detail only if it matters.\n${current}${notice}${clarify}\n${usage}`;
console.log(JSON.stringify({hookSpecificOutput:{hookEventName:event,additionalContext:context}}));
