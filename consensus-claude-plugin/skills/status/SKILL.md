---
name: status
description: Show current shared understanding for this project.
disable-model-invocation: true
allowed-tools: Bash
---
Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" status` using Bash. Present only the goal and relevant current consensus; expand if asked.
