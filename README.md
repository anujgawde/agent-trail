# agent-trail

*A local-first CLI that joins AI coding agent session traces to the git commits, pull requests, and outcomes they produced — so you can see cost-per-outcome, retry patterns, and abandonment signals per run, not just per PR.*

---

## The problem it solves

AI coding agents (Claude Code, Cursor, Aider, Devin) produce a rich semantic trail per session: prompts, tool calls, retries, token spend, duration, eventual diff. Open-source capture tools exist for each (`ccusage` for Claude Code, Cursor's Analytics API, Aider's analytics log, Langfuse integrations for most of them).

Git has the other half: commits, PRs, merge/revert history, CI status, linked issues.

**Nothing joins the two.** You can see that a Claude Code session burned $2.80 across 9 prompts. You can separately see that a PR merged at 3:47pm got reverted 36 hours later. But you cannot ask: *did the expensive, messy sessions produce the reverted PRs?* Or: *when Cursor takes one prompt, does the code stick; when it takes nine, does it get rolled back?* That join is the missing data atom for every interesting question about AI-assisted development.

`agent-trail` is a small, local, batch tool that builds that join on your own machine, from the telemetry your agents already write to disk.

## Who this is for

- **Individual developers** who want honest per-feature numbers on their AI spend: *"that refactor I shipped last Thursday actually cost me $6.40 and 22 prompts — was it worth it?"*
- **Tech leads** running AI tool evaluations who need cost-per-merged-outcome, not cost-per-seat.
- **Engineering-analytics vendors and their product engineers** who want to prototype features that depend on session ↔ PR joins (see the [applied example](#applied-example-workweave-product-engineering-sample) below).

## What it does

1. Reads AI agent session transcripts from your local filesystem (Claude Code JSONL first; Aider planned next; Cursor later).
2. Extracts: prompt count, tool-call count, retry/iteration signals, token usage, duration, working directory.
3. Joins each session to git commits whose author-time falls inside the session window in the session's working directory.
4. Enriches commits to PRs via `gh pr list --search <sha>`, capturing merge status, review state, and revert detection.
5. Persists everything in a local SQLite DB.
6. Renders a single-page static HTML dashboard: session list, a **cost-per-merged-line** headline, and expandable prompt-trail drawers per session.

No cloud, no auth, no telemetry leaves your machine.

## How you use it

Three CLI commands form the whole loop:

```bash
agent-trail ingest             # parse local JSONL, join to git, enrich with PRs → SQLite
agent-trail dashboard --open   # render dashboard.html from SQLite and open it
agent-trail demo seed          # (optional) drop in three canonical fixture sessions
```

The two usage modes:

- **One-shot demo / work sample.** Run `demo seed` → `ingest` → `dashboard --open`. The resulting `dashboard.html` is a standalone file you can email, drop in a Notion page, or screen-share.
- **Ongoing personal use.** Put `agent-trail ingest` on a nightly cron (or run it when you want to check a session). The SQLite DB grows over time; each `dashboard` render reflects everything ingested so far. Point at your real Claude Code dir: `agent-trail ingest --claude-dir ~/.claude/projects --repo /path/to/your/repo`.

### Where the analytics live

The dashboard is a **single static HTML file** rendered from a Handlebars template. Expandable sections are CSS-only — no JavaScript framework, no build step, no local server. Double-click the file, it opens in the browser.

This is a deliberate v1 choice. Static HTML is shareable (attach to a PR description, a job application, a Slack message) and costs almost nothing to build. The tradeoff: no interactive filtering, no date-range picker, no live updates. If you want those, a small local web server (Hono + HTMX, or an Express server rendering the same templates) is the v2 upgrade — same data, richer interaction.

## Demo flow (90 seconds)

```bash
agent-trail demo seed
agent-trail ingest
agent-trail dashboard --open
```

The seeded demo shows three deliberately distinguishable runs:

1. **Clean one-shot.** 1 prompt, 1 tool call, 3k tokens, $0.04, merged, clean.
2. **Messy iteration.** 9 prompts, 22 tool calls, 3 retries, 48k tokens, $2.80, merged → reverted 36h later.
3. **Human takeover.** 3 prompts, abandoned mid-session, manual commits complete the work, merged clean.

All three ship a PR that looks broadly similar in aggregate tools. The session layer is what separates them.

## Architecture

```
~/.claude/projects/**/*.jsonl    ─┐
                                  ├──► session table (SQLite)
git log --since/--until           ─┤
                                  ├──► session_commit join table
gh pr list --search <sha>         ─┤
                                  ├──► pr table
(optional) Sentry / PagerDuty     ─┘          │
                                              ▼
                                     Handlebars-rendered dashboard.html
```

One command pipeline: `agent-trail ingest && agent-trail dashboard`.

## Setup

Prerequisites: Node 20+, `gh` CLI authenticated (`gh auth status`), Claude Code installed and used at least once.

```bash
git clone <repo>
cd agent-trail
npm install
npm run build     # compiles TS; or skip and use tsx
npm link          # makes `agent-trail` available on your PATH
agent-trail --help
```

During development, use `npm run dev -- <args>` to run via `tsx` without compiling.

## Scope discipline (what's deliberately out)

- **Live / streaming capture.** Batch only. Claude Code's `SessionEnd` hook would enable real-time ingestion; deferred to v2 because the join story doesn't need it.
- **Rebuilding telemetry capture.** `ccusage`, Langfuse, and `TechNickAI/claude_telemetry` already solve capture. This tool studies their parsers, doesn't replace them.
- **Multi-agent support in v1.** Claude Code only. Aider is the v2 candidate (it already writes analytics logs); Cursor is v3 (Enterprise-only Analytics API). Doing Claude Code *well* beats doing three agents *thinly*.
- **Team rollups, auth, multi-tenancy, cloud.** Single-user, local-only. Productization is out of scope on purpose — this is a tool, not a platform.
- **LLM-as-judge quality scoring of prompts.** Tempting, but raw counts tell the story. Adding an LLM judge pre-maturely muddies the argument; deferred to v2.
- **Rich interactive UI.** Static HTML in v1. A local web server is a v2 upgrade, not a v1 feature.

## Roadmap (v2 and beyond)

- **Aider ingester.** Aider writes analytics logs directly; small parser, same join logic.
- **Cursor ingester** via the Enterprise Analytics API for teams that have it.
- **Real-time capture** via Claude Code's `SessionEnd` hook.
- **Revert / incident correlation.** Extend the `pr` table with revert detection from git history; optional Sentry / PagerDuty webhook ingesters to attach incidents to sessions.
- **Local web UI.** Swap the static HTML for a tiny Hono + HTMX server with date-range filtering and per-repo views.
- **Agent comparison view.** When multiple agents are ingested, show cost-per-outcome side-by-side per task type.
- **Prompt-Quality Index.** LLM-judge the prompts in a session trail for specificity and context; correlate prompt quality with merge / revert outcomes.

## Applied example: WorkWeave product-engineering sample

This repo doubles as a product-engineering work sample for [WorkWeave](https://workweave.dev) (YC W25; engineering analytics for AI-era teams — **not** W&B Weave).

The product argument: WorkWeave measures AI adoption at the **PR boundary** — session counts, lines-accepted, spend-over-time. Their Risk Radar, Agent Router, and cost-per-outcome roadmap all implicitly depend on a **session ↔ PR ↔ outcome join** that does not exist in their pipeline today. `agent-trail` is the smallest possible prototype of that join: ~500–700 lines of TypeScript, local-only, one agent, three canonical demo scenarios. It proves the data atom is recoverable from telemetry agents already write and exposes exactly the signal WorkWeave's next three features need.

If you are at WorkWeave: the v2 roadmap above is roughly a quarter of product roadmap you get for free once this join lands in your ingestion pipeline. Happy to talk through it.

## Prior art and credits

- **Claude Code** — session JSONL format and Hooks system.
- **[ccusage](https://github.com/ryoppippi/ccusage)** — reference implementation for parsing local Claude Code JSONL; this tool's parser is learned from theirs, not vendored. Also TypeScript, so the closest idiomatic reference for this project's code style.
- **[Langfuse Claude Code integration](https://langfuse.com/integrations/other/claude-code)** — proof semantic capture is solved upstream; frees this tool to focus on the join.
- **[TechNickAI/claude_telemetry](https://github.com/TechNickAI/claude_telemetry)** — OpenTelemetry wrapper for Claude Code; the path to real-time capture if v2 ever needs it.

## Honest caveats

- Session-to-commit attribution is **heuristic** (time-window match in the session's working directory). v2 will use Claude Code's explicit file-write tool-call events for exact attribution. The demo scenarios are constructed so the heuristic holds; the weakness is surfaced in the dashboard itself.
- Claude Code's JSONL schema is undocumented at field level and shifts between versions. The parser handles today's shape; productionization would need versioned schemas.
- This is a research prototype. The dashboard is functional and intentionally un-styled — the argument is the data, not the pixels.
