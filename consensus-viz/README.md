# Consensus Brain

A live terminal view of the Consensus Harness state, for a pane beside Claude Code. It draws the consensus as a small nervous system:

- the **goal** is the central neuron
- **agreed** items (● teal) are wired with thick axons and fire steady impulses outward
- **open** questions (◆ amber) pulse and send signals back to the goal
- **assumed** items (○ lilac) hang on faint dotted links
- **rejected** items (✕ rose) stay visible on faint dotted links, so the "no" isn't lost
- new or changed items flash and stay highlighted for a few seconds; removed items fade out in red
- a dim cortex-shaped mesh sparks in the background; when the harness is off everything greys out

The header doubles as the legend: `● 5 agreed  ◆ 2 open  ○ 2 assumed`, each in its node colour (symbols only below 60 columns).

Every item shows its full text, wrapped beside its node: in wide panes (64+ columns) in a left and a right column with the goal neuron between them, in narrow panes in one column. If a pane is too short for all items, the column ends with "+N more".

## Newest first

Items are ordered by when they were created or last changed, newest at the top (alternating right and left column). The two newest are at full strength and in bold for the newest; older ones fade step by step. When the pane is full, older items move to further pages:

- `→` older page, `←` newer page, `g` back to the newest
- `↓ 8 older` / `↑ 6 newer` at the edges tell you there is more
- moving the selection with `↑`/`↓` scrolls along

Order comes from the `at`/`updated` timestamps the state script writes (plugin 0.2.6+). Older items without timestamps keep their creation order, below the timestamped ones.

## Answer Claude from the viewer

Press `↓` to select an item (the first press lands on the first assumption), move with `↑`/`↓` (or `j`/`k`), then:

- `a`: agree. Claude's assumption becomes an agreed decision.
- `o`: mark it open, still to be discussed.
- `n`: add a note: a follow-up or constraint, e.g. when you only partly agree. Type it, `enter` saves, `esc` cancels. It shows as `↳ …` under the item; Claude sees it as your note and gets it announced on your next prompt. The status stays as it is.
- `d`: disagree. The item turns ✕ rejected and stays, so Claude knows you said no and won't propose it again. A "why?" prompt follows; type a reason or press `esc`.
- `x` twice: forget it completely, as if it was never there (for mistakes; to say no, use `d`).
- `esc`: stop selecting.

The change is written through the plugin's own state script (`consensus-claude-plugin/scripts/state.mjs`, or `$CONSENSUS_STATE_CLI`), so the same rules apply as when Claude writes. Claude sees it in its context on your next prompt. Nothing is written when the harness is off. While an item is selected the viewer stays on the current consensus instead of following a newer one.

Apart from these actions it only reads `~/.consensus-harness/` (or `$CONSENSUS_HOME`). Node.js 20+, no dependencies.

## How it works (in four lines)

1. Talk with Claude as usual. Goal and decisions land here.
2. ○ is Claude's assumption. Check it: `↓` to select, `a` to agree.
3. ● agreed is what Claude works from. ◆ open is undecided.
4. Your changes here reach Claude with your next message.

The same four lines open the `?` overlay, and an empty consensus points new users there.

## Run

```bash
node consensus-viz/brain.mjs                    # follow whichever consensus changed last
node consensus-viz/brain.mjs --project ~/code/x # pin one project folder
node consensus-viz/brain.mjs --no-mesh          # calmer: no background mesh
node consensus-viz/brain.mjs --once --size 100x36   # print one frame and exit
```

Press `?` for an overlay with the four steps below and what each status means for you and Claude (`?` or `esc` closes it).

Keys: `↑↓` select · `a`/`d`/`o`/`n`/`x` act on the selection · `←→` newer/older page · `g` newest · `q` quit · `tab` cycle through all stored consensus states (pins) · `p` toggle pinned/following · `m` toggle the mesh · `?` legend.

By default it follows the most recently changed state file, so it jumps to whatever Claude session last recorded something. With two sessions active, press `p` to stay on one.

Needs a truecolor terminal and a font with braille characters (any Nerd Font, JetBrains Mono, etc.).
