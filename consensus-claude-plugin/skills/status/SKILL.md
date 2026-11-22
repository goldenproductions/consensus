---
name: status
description: Show current shared understanding for this project.
disable-model-invocation: true
allowed-tools: Bash
---
Run the state manager command shown in the Consensus Harness context with `status` using Bash (it pins the project, and in the home folder the session). If that context is missing, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" status`. Present only the goal and relevant current consensus; expand if asked.
