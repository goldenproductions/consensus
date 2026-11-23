# Consensus

Shared understanding between you and your AI coding agent. Consensus keeps a live record of what you and the AI agreed: the goal, why you want it, the decisions, the AI's assumptions and the open questions. The AI works from it, asks before it builds on guesses, and you can see and change it at any time in a terminal pane beside the chat.

Works with **Claude Code** and **Codex**. Local-first: everything stays in `~/.consensus-harness/` on your machine, with no extra API key or model calls.

## What it does

- **Agreed vs. assumed.** Your decisions are saved as *agreed*, in your words. Anything the AI fills in on its own is *assumed* until you confirm it. Things you said no to stay as *rejected*, so they aren't proposed again.
- **Ask first.** On a vague request ("build me a website with images of cars") the AI asks the 1–3 questions that matter (what problem, which stack, for whom) before spending tokens on guesses. It's a nudge, never a lock: say "go" and it proceeds on its own recommendations.
- **Short replies.** The first line is what the AI needs from you.
- **Memory.** Each session is compacted into per-project long-term memory automatically. Nothing to save by hand.
- **Decisions linked to code.** File edits are traced to the decision they carry out, so you can see which files a decision touched and spot work that rests on nothing you agreed.

## The viewer: Consensus Brain

```bash
node consensus-viz/brain.mjs
```

A live terminal view for a pane beside the chat, drawn as a small nervous system: the goal in the middle, decisions grouped by topic, the AI's activity firing through the mesh. Agree (`a`), disagree (`d`), add a note (`n`) or your own item (`+`) right there. The AI picks your change up within seconds, with no need to type in the chat. Press `?` for help. See [consensus-viz/README.md](consensus-viz/README.md).

## Install

Claude Code:

```bash
claude plugin marketplace add goldenproductions/consensus
claude plugin install consensus@consensus
```

Codex (0.171+, with `features.hooks = true`):

```bash
codex plugin marketplace add https://github.com/goldenproductions/consensus
codex plugin add consensus@consensus
```

Codex also needs the state folder writable from its sandbox; see [the plugin README](consensus-claude-plugin/README.md#codex). Node.js 20+ is the only requirement.

## License

MIT. The optional companion plugin [unslop](https://github.com/heydamir/unslop) is CC-BY-4.0 by Damir Sokolovsky and is installed from its own repository, not included here.
