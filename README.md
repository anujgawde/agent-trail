# agent-trail

A local CLI that connects Claude Code session transcripts to the git commits and pull requests they produced. See what each AI session actually cost, what it shipped, and whether the code stuck.

## The Problem

AI coding agents write detailed telemetry to disk — prompts, tool calls, token spend, retries, working directory. Git tracks everything on the other side — commits, PRs, merge history, reverts.

These two data sources are never joined. A $2.80 Claude Code session and the PR that got reverted 36 hours later exist in completely separate systems. There is no way to ask: _were the expensive, messy sessions the ones that produced the reverted PRs?_

`agent-trail` builds that join locally, from telemetry that already exists on the machine.

## Ideal Users

- **Individual developers** who want per-feature AI spend numbers: how many prompts, how much it cost, did the code merge cleanly.
- **Tech leads** evaluating AI tools who need cost-per-merged-outcome, not cost-per-seat.
- **Engineering analytics teams** prototyping features that depend on a session ↔ PR ↔ outcome join.

## What It Does

1. Reads Claude Code session transcripts from `~/.claude/projects` (JSONL format).
2. Extracts prompt count, tool-call count, retry signals, token usage, and cost per session.
3. Matches each session to git commits whose author timestamp falls within the session window.
4. Looks up each commit's pull request via the GitHub CLI, capturing merge status and revert detection.
5. Persists everything to a local SQLite database.
6. Renders a static HTML dashboard with a cost-per-merged-line headline, per-session cost breakdown, and expandable commit and PR details.

No data leaves the machine. No cloud. No auth beyond what `gh` already manages.

## Quick Start

**Prerequisites:** Node 20+, [GitHub CLI](https://cli.github.com) authenticated, Claude Code installed and used at least once.

```bash
git clone <repo>
cd agent-trail
npm install
npm run build
npm link

agent-trail --help
```

### Run Against Real Data

```bash
agent-trail ingest --claude-dir ~/.claude/projects --repo /path/to/repo
agent-trail dashboard --open
```

### Try The Demo

```bash
agent-trail demo seed
agent-trail ingest
agent-trail dashboard --open
```

The demo seeds three scenarios designed to show different outcomes on sessions that look similar from the outside:

| Session | Prompts | Cost | Outcome |
|---------|---------|------|---------|
| Clean one-shot | 1 | $0.05 | Merged, clean |
| Messy iteration | 9 | $1.65 | Merged → reverted 36h later |
| Human takeover | 3 | $0.09 | Abandoned mid-session |

Example `ingest` output:

```
$ agent-trail ingest
[agent-trail] Opening database: ~/.agent-trail/db.sqlite
[agent-trail] Scanning for sessions in: ~/.claude/projects
[agent-trail] Found 3 session file(s)
  [1] demo-000… prompts=1 tools=1 cost=$0.0504
  [2] demo-000… prompts=9 tools=22 cost=$1.6502
  [3] demo-000… prompts=3 tools=5 cost=$0.0938

[agent-trail] Done. parsed=3 skipped=0 commits_enriched=3
Run: agent-trail dashboard --open
```

## CLI Reference

```
agent-trail ingest [options]
  --claude-dir <path>   Claude projects directory (default: ~/.claude/projects)
  --repo <path>         Git repository path (default: .)
  --since <date>        Only ingest sessions after this date
  --db <path>           SQLite database path (default: ~/.agent-trail/db.sqlite)

agent-trail dashboard [options]
  --open                Open in browser after rendering
  --out <path>          Output file (default: dashboard.html)
  --db <path>           SQLite database path (default: ~/.agent-trail/db.sqlite)

agent-trail demo seed   Load canonical fixture sessions
agent-trail demo clean  Remove fixture sessions
```

## Architecture

```
~/.claude/projects/**/*.jsonl ──► parse sessions
                                        │
                                  git log --since/--until
                                        │
                                  gh pr list --search <sha>
                                        │
                                   SQLite (local)
                                        │
                                  dashboard.html (static)
```

Three tables: `session`, `session_commit`, `pr`. The join between them is the core of the tool.

## Dashboard

The output is a single static HTML file — no server, no JavaScript framework, no build step. Open it in a browser, attach it to a PR, or drop it in a shared drive.

The headline metric is **cost per merged line**: total session spend divided by lines of code that landed in merged, non-reverted PRs.

## Attribution Model

Sessions are matched to commits by author timestamp: commits whose `git log` author time falls within the session's start and end time, in the same working directory. This is a heuristic — it holds well for single-developer workflows and breaks down when multiple sessions overlap or commits are made outside Claude Code. Exact attribution via file-path matching is planned for v2.

## Limitations

- **Claude Code only** in v1. Aider and Cursor are planned.
- **Single-user, local only.** No team aggregation, no cloud sync.
- **Batch ingestion.** Sessions are processed after the fact, not captured live.
- **Heuristic attribution.** Time-window matching, not exact file-level provenance.
- **Undocumented JSONL schema.** Claude Code's session format is not officially documented and changes between versions. The parser handles the current shape and validates with Zod; schema drift will surface as parse errors with line numbers.

## Roadmap

- Aider ingester (writes analytics logs natively)
- Cursor ingester via Enterprise Analytics API
- Real-time capture via Claude Code's `SessionEnd` hook
- Revert and incident correlation (Sentry / PagerDuty webhooks)
- Local web UI with date-range filtering (Hono + HTMX)
- Agent comparison: cost-per-outcome side-by-side across tools

## Credits

- **[ccusage](https://github.com/ryoppippi/ccusage)** — reference implementation for parsing Claude Code JSONL
- **[Langfuse Claude Code integration](https://langfuse.com/integrations/other/claude-code)** — prior art for session capture
- **[TechNickAI/claude_telemetry](https://github.com/TechNickAI/claude_telemetry)** — OpenTelemetry wrapper for Claude Code
