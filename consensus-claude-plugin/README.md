# Consensus — plugin for Claude Code and Codex

A tiny **local-first** collaborative layer for Claude Code in your terminal. No extra API key or model call. Uses your current Claude Code session.

## Test without installing

Run this from any project directory:

```bash
claude --plugin-dir /absolute/path/to/consensus-claude-plugin
```

This loads the plugin for that one Claude Code invocation only.

## Install permanently (local marketplace)

The parent folder `consensus-skill/` is a local marketplace (`.claude-plugin/marketplace.json`, name `consensus`):

```bash
claude plugin marketplace add /absolute/path/to/consensus-skill
claude plugin install consensus@consensus
```

Or inside Claude Code: `/plugin marketplace add /absolute/path/to/consensus-skill`, then `/plugin install consensus@consensus`. After changing the plugin, bump `version` in both `plugin.json` and `marketplace.json`, run `claude plugin marketplace update consensus`, and start a new session. Remove with `claude plugin uninstall consensus@consensus`.

## Ask first (soft clarify gate)

While the goal, the why (`why -`, the problem the work solves) or questions marked `--first` are unsettled, every prompt carries a CLARIFY FIRST note: before building on a vague request, ask the 1-3 questions that matter most, each with a recommendation, and record them with `add open --first`. Clear or small tasks need no questions. `go` (the user's "go", or `G` in the viewer) clears the ask-first marks and lets the AI proceed on its recommendations, saved as assumed. It never blocks a tool call.

## Decision trace

`work <id>` tells the plugin which item the AI is carrying out; the activity hook then records each file edit (Edit, MultiEdit, Write, NotebookEdit, Codex apply_patch) under that item in `~/.consensus-harness/trace/<session>.json`, or under `_unlinked` when no item is set. The viewer shows the files per item and flags drift (edits on rejected items), unconfirmed work (open/assumed) and unlinked edits. Only file paths are recorded, never contents.

## Auto-wake

After each reply, `scripts/watch.mjs` waits in the background for your changes in the Consensus viewer. About 4 seconds after your last change (longer while you're typing a note in the viewer) it hands them to the AI, so you don't have to write in the chat to make it see them. Claude Code runs it as an `asyncRewake` Stop hook (exit code 2 wakes the model); Codex has no such hook, so there the watcher detaches and delivers the message with `codex queue`. It stops quietly when you prompt first (your prompt carries the changes anyway), after an hour, or when auto-wake is off (`W` in the viewer, stored in `~/.consensus-harness/settings.json`). Each wake is one AI turn.

## Codex

Codex (0.171+) reads this plugin as it is: it understands `.claude-plugin/`, `hooks/hooks.json` and `${CLAUDE_PLUGIN_ROOT}`. The consensus, memory, viewer and activity are shared: the viewer shows a Codex session like a Claude one, with "Codex" in the activity line.

```bash
codex plugin marketplace add /absolute/path/to/consensus-skill
codex plugin add consensus@consensus
```

Then, in `~/.codex/config.toml`:

```toml
[features]
hooks = true

# the model writes the consensus with the state script; let the sandbox write there
[sandbox_workspace_write]
writable_roots = ["/home/<you>/.consensus-harness"]
```

### Codex on Windows

In Windows PowerShell, type `codex.cmd` instead of `codex`: the npm install also puts a `codex.ps1` on the PATH, which PowerShell's default execution policy blocks.

```powershell
codex.cmd plugin marketplace add https://github.com/goldenproductions/consensus
codex.cmd plugin add consensus@consensus
```

The sandbox rule takes a Windows path (a TOML literal string, so backslashes need no escaping):

```toml
[sandbox_workspace_write]
writable_roots = ['C:\Users\<you>\.consensus-harness']
```

Codex on Windows runs commands in PowerShell, so the plugin tells it the PowerShell form of the state commands (`$env:` variables and a single-quoted here-string piped to `node`). Claude Code, including on Windows (Git Bash), gets the Bash form. Set `CONSENSUS_SHELL=powershell` or `bash` to override. Auto-wake finds `codex.exe` or the npm package's `codex.js` itself; set `CONSENSUS_CODEX` to the codex executable if it can't, and see `~/.consensus-harness/logs/watch.log` when a wake doesn't arrive.

Start `codex` and choose **Trust all and continue** when it asks to review the new hooks (or review them with `/hooks`). Codex asks again whenever the hooks change. Turn consensus on per folder with `node consensus-claude-plugin/scripts/state.mjs on` from that folder. After changing the plugin, bump the version and run `codex plugin add consensus@consensus` again. The unslop companion is Claude Code only.

## Companion plugin: unslop

`consensus` depends on [unslop](https://github.com/heydamir/unslop) (CC-BY-4.0, by Damir Sokolovsky). The `consensus` marketplace lists it straight from upstream, pinned to a reviewed commit, so installing consensus installs and enables unslop too. Nothing of unslop is copied into this repo. The plugin treats unslop's confirmed design direction as an agreed `UI direction:` item, so later unslop runs and other work in the project stay on that direction. To move to a newer unslop, review the upstream diff, change `sha` in `.claude-plugin/marketplace.json`, and run `claude plugin marketplace update consensus`.

## Commands inside Claude Code

- `/consensus:on` — enable for the project (on by default)
- `/consensus:off` — disable for the project, preserving state
- `/consensus:status` — inspect the shared understanding
- `/consensus:view` — open the Consensus viewer beside the chat (split pane or new window; otherwise prints the command)
- `/consensus:consensus` — explicitly request a consensus update

If command names differ on your Claude Code version, inspect the loaded plugin via `/plugin`. You can always use the direct CLI described below.

## Direct state CLI

Run from the project directory (outside Claude Code if desired):

```bash
node /absolute/path/to/consensus-claude-plugin/scripts/state.mjs status
node /absolute/path/to/consensus-claude-plugin/scripts/state.mjs off
node /absolute/path/to/consensus-claude-plugin/scripts/state.mjs on
node /absolute/path/to/consensus-claude-plugin/scripts/state.mjs add agreed "We will build a local-first plugin"
```

Statuses: `agreed`, `assumed`, `open`, and `rejected` (the user said no; Claude won't act on it or propose it again). `note <id> -` attaches a follow-up or constraint to an item.

Pass `-` instead of the text to read it from stdin. Claude is told to always do this with a quoted heredoc (`add agreed - <<'EOF'`), so `$(...)`, backticks or `$VAR` in your words are stored as written and never run by the shell. `edit` and `remove` accept the short id shown in brackets (any unique prefix of 4+ characters).

The state is saved under `~/.consensus-harness/projects/<hash>.json`, keyed by session (`~/.consensus-harness/sessions/`), with the on/off switch and long-term memory per project folder: `CONSENSUS_PROJECT` if set, else `CLAUDE_PROJECT_DIR`, else the nearest git root above the current directory, else the current directory. The hook passes `CONSENSUS_PROJECT` explicitly in the command it shows Claude, so running the CLI from a subfolder still hits the same state. Sessions started in your home folder (or `/`) are not a project, so there each session gets its own state under `~/.consensus-harness/sessions/`, keyed by session id. It survives `--resume` and compaction, starts fresh after `/clear`, and is deleted after 30 days without use. The on/off switch for the home folder still applies to all of those sessions. To override location, set `CONSENSUS_HOME`. It is not written into your project repository. Be careful with sensitive project decisions: they persist on disk.

## How it works

- With the unslop skill installed, Claude is told to load the `consensus` skill first. That skill holds the rules for reusing and recording the `UI direction:` item, so they are not injected into every session.
- The `SessionStart` hook (startup, resume, `/clear`, compaction) injects the conversation guidance; the `UserPromptSubmit` hook injects only the current consensus and the state-manager command, if enabled.
- Claude's own model does the interpretation. No independent Consensus Engine model runs.
- The `consensus` skill describes how Claude can update state through the local state CLI.
- The hook **does not** guarantee automatic agreement detection or enforce model behavior. Initial agreement extraction relies on Claude invoking its tools appropriately; test this before relying on it.
- `off` disables future hook injection but cannot erase context already injected within the current running session. Start a fresh Claude session for complete isolation.

## Long-term memory (automatic)

Every session has its own working consensus. Its compact form (goal, a 1-3 line gist that Claude keeps, agreed and rejected items with your notes, up to 5 open questions; assumptions are dropped) is saved to `~/.consensus-harness/memory/<project>.json` on every prompt and at session end. Nothing to save by hand.

A new session in the same project starts with that memory, newest first: the last 3 sessions with their decisions, older ones (up to 12) as goal and gist only. Claude treats it as background: it builds on it, re-confirms old details, and never re-proposes what was rejected. Sessions started in the home folder only keep a one-line goal index, since they are unrelated topics. A project's consensus from before memory existed is imported once as the oldest entry. Inspect with `node scripts/memory.mjs` (or `json`) from the project folder.

## Changes made in the viewer

The Consensus viewer (`viz/`) writes through the same state script with `CONSENSUS_BY=user`. Such items carry `by: "user"` and show to Claude as "set by the user in the viewer", and the next prompt in each session lists what the user changed since Claude's last reply, so Claude acts on it instead of asking again or reverting it. Every add/edit/remove is also kept in a short `events` log in the state file (last 30).

## Live activity for the viewer

`scripts/activity.mjs` runs on UserPromptSubmit, PreToolUse, PermissionRequest, Notification, Stop and SessionEnd (in Claude Code and Codex) and writes the session's current activity (thinking, working on X, waiting, your turn) to `~/.consensus-harness/activity/<session>.json` for the Consensus viewer. It prints nothing, takes a few tens of milliseconds, and records only file names or the tool's own description, never command text. It does nothing while the harness is off.

## Requirements

Node.js 20+ and a recent Claude Code CLI. No npm install needed.

## Known limitations

- Does not change Claude Code's terminal UI or provide a side panel.
- Does not modify or halt an in-flight tool call.
- Skills are model guidance, not guaranteed control; hook support varies by Claude Code version.
- No API key needed beyond your normal Claude Code authentication.
