# Consensus Brain

A live terminal view of the Consensus state, for a pane beside Claude Code. It draws the consensus as a small nervous system:

- the **goal** is the central neuron
- **agreed** items (● teal) are wired with thick axons and fire steady impulses outward
- **open** questions (◆ amber) pulse and send signals back to the goal
- **assumed** items (○ lilac) hang on faint dotted links and flicker between ○ and ◌ until you confirm them
- **rejected** items (✕ rose) stay visible on faint dotted links, so the "no" isn't lost
- **done** items (✓) are decisions whose work is finished: dimmed, with a line saying how (`✓ merged in PR #16`)
- new or changed items flash and stay highlighted for a few seconds; removed items fade out in red
- a dim cortex-shaped mesh sparks in the background; when consensus is off everything greys out

The header doubles as the legend: `● 5 agreed  ◆ 2 open  ○ 2 assumed`, each in its node colour (symbols only below 60 columns).

Every item shows its full text, wrapped beside its node: in wide panes (64+ columns) in a left and a right column with the goal neuron between them, in narrow panes in one column. If a pane is too short for all items, the column ends with "+N more".

## Topics

Claude gives every item a short topic. The viewer groups by it: the left column lists every topic on one line (name plus counts, newest topic on top), and the right column shows the open topic's items in full, wired from the goal through the topic's hub. It follows the newest topic; `←`/`→` open a newer/older topic and `g` goes back to following. Items without a topic are under "General". Narrow panes show only the open topic, with its name and position in a title row.

## Newest first

Items are ordered by when they were created or last changed, newest at the top (alternating right and left column). The two newest are at full strength and in bold for the newest; older ones fade step by step. When the pane is full, older items move to further pages:

- `pgdn`/`]` older page, `pgup`/`[` newer page (within the open topic)
- `↓ 8 older` / `↑ 6 newer` at the edges tell you there is more
- moving the selection with `↑`/`↓` scrolls along

Order comes from the `at`/`updated` timestamps the state script writes (plugin 0.2.6+). Older items without timestamps keep their creation order, below the timestamped ones.

## Live activity

Under the goal, a status line shows what Claude is doing in the followed session: `⠼ Claude · editing brain.mjs`, `⚠ Claude needs your permission…`, or `◉ your turn` (plus how many items need you). The brain shows it too: while Claude **thinks**, slow violet waves roll out from the goal; while it **works**, the network fills with fast sparks in the colour of the work (cyan reading or searching, amber editing, green running commands, magenta delegating, blue on the web); when it **waits for your permission**, the network dims and an amber beacon pulses from the goal; on **your turn** it settles down. This comes from the plugin's activity hook (plugin 0.6.0+), which writes `~/.consensus-harness/activity/<session>.json` on each prompt, tool call, notification and stop. Labels are file names or the tool's own short description, never command text.

## Ask first

On a vague request ("build me a website with images of cars") the AI asks before it builds: the why (the problem it solves) and the 1-3 questions that would most change the result, each with its recommendation. The header shows `? 2 ask first`, those questions carry a `?` beside their node and come first when you press `enter`, and a `why` line under the goal shows the agreed why (or that it isn't agreed yet). Answer with `n` (your answer as a note) and `a`, or in the chat. Press `G` to let the AI go with its own recommendations; they are saved as assumed. Nothing is blocked: it's a nudge, not a lock.

## Auto-wake

Your changes in the viewer reach the AI within seconds when it's your turn (plugin 0.10+): no need to type in the chat. After each action the viewer says when the AI will see it (`in a few seconds`, `when it finishes`, or `with your next message`). While you type a note the wake waits for you. `W` turns auto-wake off and on; the footer shows `wake off` while it's off.

## Decisions linked to code

Before the AI edits files it says which item the edits carry out (`work <id>`), and from then on the plugin's activity hook records every file it edits under that item (`~/.consensus-harness/trace/<session>.json`; Claude Code's Edit/Write and Codex's apply_patch). The activity line shows it: `Claude · editing index.html → Plain HTML and CSS`, and the item being worked on carries a `⌁`. Select an item to see the files it touched (`⌁ index.html ×3 · style.css`). The header warns when work doesn't rest on an agreed decision: `✕ drift` (edits on something you rejected, files shown under it), `△ unconfirmed` (on an open or assumed item) or `⌁ unlinked` (on no item at all).

## What needs you

The header shows `⚑ 2 need you`: the assumptions and open questions Claude is waiting on, across all topics (or `✓ all clear`). Press `enter` to jump to the next one, in whatever topic it is, then answer it with `a`, `d` or `n`.

## Answer Claude from the viewer

Press `↓` to select an item (the first press lands on the first assumption), move with `↑`/`↓` (or `j`/`k`), then:

- `a`: agree. Claude's assumption becomes an agreed decision.
- `o`: mark it open, still to be discussed.
- `n`: add a note: a follow-up or constraint, e.g. when you only partly agree. Type it, `enter` saves, `esc` cancels. It shows as `↳ …` under the item; Claude sees it as your note and gets it announced on your next prompt. The status stays as it is.
- `d`: disagree. The item turns ✕ rejected and stays, so Claude knows you said no and won't propose it again. A "why?" prompt follows; type a reason or press `esc`.
- `x` twice: forget it completely, as if it was never there (for mistakes; to say no, use `d`).
- `esc`: stop selecting.

The selected item keeps its status colour and breathes; the footer names its status (`○ assumed · a agree …`).

## Add your own items

Press `+` and type a rule, constraint or question (`enter` continues, `esc` cancels), then choose how to save it: `a` agreed (a decision or rule Claude must follow; `enter` does the same) or `o` open (a question to settle). It lands in the topic you're looking at, marked as yours, and Claude is told about it on your next message, so you don't have to say it in the chat.

The change is written through the plugin's own state script (`consensus-claude-plugin/scripts/state.mjs`, or `$CONSENSUS_STATE_CLI`), so the same rules apply as when Claude writes. Claude sees it in its context on your next prompt. Nothing is written when consensus is off. While an item is selected the viewer stays on the current consensus instead of following a newer one.

Apart from these actions it only reads `~/.consensus-harness/` (or `$CONSENSUS_HOME`). Node.js 20+, no dependencies.

## How it works (in four lines)

1. Talk with Claude as usual. Goal and decisions land here.
2. ○ is Claude's assumption. Check it: `↓` to select, `a` to agree.
3. ● agreed is what Claude works from. ◆ open is undecided.
4. Your changes here, and your own items (+), reach Claude with your next message.

The same four lines open the `?` overlay, and an empty consensus points new users there.

## Run

Inside Claude Code or Codex: `/consensus:view`. It runs `scripts/view.mjs`, which opens the viewer in a split pane (herdr, tmux, WezTerm, Windows Terminal, iTerm2) or a new window (Terminal.app, a Windows console), and prints the command to start it by hand with the full path. Set `CONSENSUS_VIEW=print` to only print it, or `CONSENSUS_VIEW=herdr|tmux|wezterm|wt|iterm|terminal|console` to force one method.

By hand, from the plugin folder (in a clone of the repo, `node consensus-viz/brain.mjs` also works and forwards here):

```bash
node viz/brain.mjs                        # follow whichever consensus changed last
node viz/brain.mjs --project ~/code/x     # pin one project folder
node viz/brain.mjs --no-mesh              # calmer: no background mesh
node viz/brain.mjs --once --size 100x36   # print one frame and exit
```

Press `?` for an overlay with the four steps below and what each status means for you and Claude (`?` or `esc` closes it).

Keys: `enter` next item that needs you · `↑↓` select · `a`/`d`/`o`/`n`/`x` act on the selection · `+` add your own item · `←→` topic · `pgup/pgdn` page · `g` newest topic · `q` quit · `tab` cycle through all stored consensus states (pins) · `p` toggle pinned/following · `m` toggle the mesh · `?` legend.

By default it follows the most recently changed state file, so it jumps to whatever Claude session last recorded something. With two sessions active, press `p` to stay on one.

Needs a truecolor terminal and a font with braille characters (any Nerd Font, JetBrains Mono, etc.).
