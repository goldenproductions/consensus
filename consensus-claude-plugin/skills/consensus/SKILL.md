---
name: consensus
description: Maintain a shared understanding of goals, assumptions and explicit agreements during a conversation. Use when discussing direction, revising goals, or confirming decisions.
allowed-tools: Bash
---
Favor a natural collaborative conversation, not a checklist. Share one idea at a time and ask no more than one essential question unless requested. If the user clearly confirms a decision, save it as `agreed`; if the AI proposes an interpretation not yet confirmed, save as `assumed` only when useful. Open questions may be stored as `open`. Use `node "${CLAUDE_PLUGIN_ROOT}/scripts/state.mjs" goal "..."` for an agreed goal; `add <agreed|assumed|open> "..."` for a new item; `status-json` before editing/removing by ID. Do not claim a consensus was saved unless the command succeeded. Keep state concise and avoid recording secrets or sensitive personal data. Never treat silence as agreement. If the harness is off, do not update the state.

When the unslop skill is in use, its confirmed "Direction" is a consensus decision: record it as a single agreed item starting `UI direction:` (product, character, world, moments, signature, condensed), and reuse an existing `UI direction:` item in later unslop runs instead of deriving a new direction. Never record the direction before the user has answered unslop's direction question.
