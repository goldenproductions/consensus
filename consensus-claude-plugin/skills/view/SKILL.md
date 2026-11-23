---
name: view
description: Open the Consensus viewer (the live consensus brain) in a pane beside the chat. Use when the user asks to see, open or start the Consensus viewer.
allowed-tools: Bash
---
Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/view.mjs"` using Bash, from the project folder. It opens the viewer in a split pane where the terminal allows it (herdr, tmux, WezTerm, Windows Terminal, iTerm2) or in a new window, and always prints the command to start it by hand. Pass viewer options after it if the user asks for them (`--project <dir>` to pin one project, `--no-mesh` for a calmer view).

Reply in one or two lines: where it opened, or, if it could not open a pane, the exact command it printed so the user can run it in a terminal beside the chat. Mention that `?` in the viewer shows the keys.
