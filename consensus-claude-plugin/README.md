# Consensus Harness — Claude Code plugin v0.1

A tiny **local-first** collaborative layer for Claude Code in your terminal. No extra API key or model call. Uses your current Claude Code session.

## Test without installing

Run this from any project directory:

```bash
claude --plugin-dir /absolute/path/to/consensus-claude-plugin
```

This loads the plugin for that one Claude Code invocation only.

## Install permanently (local marketplace)

The parent folder `consensus-skill/` is a local marketplace (`.claude-plugin/marketplace.json`, name `consensus-local`):

```bash
claude plugin marketplace add /absolute/path/to/consensus-skill
claude plugin install consensus-harness@consensus-local
```

Or inside Claude Code: `/plugin marketplace add /absolute/path/to/consensus-skill`, then `/plugin install consensus-harness@consensus-local`. After changing the plugin, bump `version` in both `plugin.json` and `marketplace.json`, run `claude plugin marketplace update consensus-local`, and start a new session. Remove with `claude plugin uninstall consensus-harness@consensus-local`.

## Commands inside Claude Code

- `/consensus-harness:on` — enable for the project (on by default)
- `/consensus-harness:off` — disable for the project, preserving state
- `/consensus-harness:status` — inspect the shared understanding
- `/consensus-harness:consensus` — explicitly request a consensus update

If command names differ on your Claude Code version, inspect the loaded plugin via `/plugin`. You can always use the direct CLI described below.

## Direct state CLI

Run from the project directory (outside Claude Code if desired):

```bash
node /absolute/path/to/consensus-claude-plugin/scripts/state.mjs status
node /absolute/path/to/consensus-claude-plugin/scripts/state.mjs off
node /absolute/path/to/consensus-claude-plugin/scripts/state.mjs on
node /absolute/path/to/consensus-claude-plugin/scripts/state.mjs add agreed "We will build a local-first plugin"
```

The state is saved under `~/.consensus-harness/projects/<hash>.json`, keyed by the project folder: `CONSENSUS_PROJECT` if set, else `CLAUDE_PROJECT_DIR`, else the nearest git root above the current directory, else the current directory. The hook passes `CONSENSUS_PROJECT` explicitly in the command it shows Claude, so running the CLI from a subfolder still hits the same state. To override location, set `CONSENSUS_HOME`. It is not written into your project repository. Be careful with sensitive project decisions: they persist on disk.

## How it works

- The `SessionStart` hook (startup, resume, `/clear`, compaction) injects the conversation guidance; the `UserPromptSubmit` hook injects only the current consensus and the state-manager command, if enabled.
- Claude's own model does the interpretation. No independent Consensus Engine model runs.
- The `consensus` skill describes how Claude can update state through the local state CLI.
- The hook **does not** guarantee automatic agreement detection or enforce model behavior. Initial agreement extraction relies on Claude invoking its tools appropriately; test this before relying on it.
- `off` disables future hook injection but cannot erase context already injected within the current running session. Start a fresh Claude session for complete isolation.

## Requirements

Node.js 20+ and a recent Claude Code CLI. No npm install needed.

## Known limitations

- Does not change Claude Code's terminal UI or provide a side panel.
- Does not modify or halt an in-flight tool call.
- Skills are model guidance, not guaranteed control; hook support varies by Claude Code version.
- No API key needed beyond your normal Claude Code authentication.
