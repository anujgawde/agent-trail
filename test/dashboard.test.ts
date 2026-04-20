import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { openDb, insertSession, insertCommit, upsertPr } from "../src/store.js";
import { renderDashboard } from "../src/dashboard.js";
import type { Session } from "../src/jsonl-parser.js";
import type { CommitRow, PrRow } from "../src/store.js";
import { readFileSync } from "node:fs";

const session: Session = {
  id: "dash-session-001",
  started_at: "2026-04-01T10:00:00.000Z",
  ended_at: "2026-04-01T10:15:00.000Z",
  cwd: "/home/user/my-project",
  prompt_count: 3,
  tool_call_count: 5,
  retry_count: 1,
  input_tokens: 5000,
  output_tokens: 1200,
  cost_usd: 0.033,
  abandoned: 0,
};

const commit: CommitRow = {
  session_id: "dash-session-001",
  sha: "abc123def456abc123",
  authored_at: "2026-04-01T10:08:00.000Z",
  added_lines: 80,
  deleted_lines: 12,
};

const pr: PrRow = {
  sha: "abc123def456abc123",
  number: 77,
  state: "MERGED",
  merged_at: "2026-04-01T11:00:00.000Z",
  reverted: 0,
  url: "https://github.com/user/my-project/pull/77",
};

describe("renderDashboard", () => {
  it("renders HTML containing expected session and PR data", async () => {
    const db = openDb(":memory:");
    insertSession(db, session);
    insertCommit(db, commit);
    upsertPr(db, pr);

    const outDir = mkdtempSync(join(tmpdir(), "agent-trail-dash-"));
    const outPath = join(outDir, "dashboard.html");

    await renderDashboard(db, outPath, false);

    const html = readFileSync(outPath, "utf8");
    expect(html).toContain("agent-trail");
    expect(html).toContain("my-project");
    expect(html).toContain("abc123d");         // sha_short
    expect(html).toContain("#77");             // PR number
    expect(html).toContain("Merged");
    expect(html).toContain("$0.0004");         // cost per merged line: 0.033/80
  });

  it("renders empty state when no sessions exist", async () => {
    const db = openDb(":memory:");

    const outDir = mkdtempSync(join(tmpdir(), "agent-trail-dash-"));
    const outPath = join(outDir, "dashboard.html");

    await renderDashboard(db, outPath, false);

    const html = readFileSync(outPath, "utf8");
    expect(html).toContain("agent-trail ingest");
  });
});
