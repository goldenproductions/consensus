# Consensus Brain

A live terminal view of the Consensus Harness state, for a pane beside Claude Code. It draws the consensus as a small nervous system:

- the **goal** is the central neuron
- **agreed** items (● teal) are wired with thick axons and fire steady impulses outward
- **open** questions (◆ amber) pulse and send signals back to the goal
- **assumed** items (○ lilac) hang on faint dotted links
- new or changed items flash and stay highlighted for a few seconds; removed items fade out in red
- a dim cortex-shaped mesh sparks in the background; when the harness is off everything greys out

The header doubles as the legend: `● 5 agreed  ◆ 2 open  ○ 2 assumed`, each in its node colour (symbols only below 60 columns).

Every item shows its full text, wrapped beside its node: in wide panes (64+ columns) in a left and a right column with the goal neuron between them, in narrow panes in one column. If a pane is too short for all items, the column ends with "+N more".

It only reads `~/.consensus-harness/` (or `$CONSENSUS_HOME`) and never writes. Node.js 20+, no dependencies.

## Run

```bash
node consensus-viz/brain.mjs                    # follow whichever consensus changed last
node consensus-viz/brain.mjs --project ~/code/x # pin one project folder
node consensus-viz/brain.mjs --no-mesh          # calmer: no background mesh
node consensus-viz/brain.mjs --once --size 100x36   # print one frame and exit
```

Press `?` for an overlay that explains every colour and effect (`?` or `esc` closes it).

Keys: `q` quit · `tab` cycle through all stored consensus states (pins) · `p` toggle pinned/following · `m` toggle the mesh · `?` legend.

By default it follows the most recently changed state file, so it jumps to whatever Claude session last recorded something. With two sessions active, press `p` to stay on one.

Needs a truecolor terminal and a font with braille characters (any Nerd Font, JetBrains Mono, etc.).
