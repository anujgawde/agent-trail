import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, getPrForSha } from "../src/store.js";
import { enrichCommits } from "../src/pr-enricher.js";
import type { CommitRow } from "../src/store.js";
import type { Session } from "../src/jsonl-parser.js";
import Database from "better-sqlite3";

vi.mock("../src/shell.js", () => ({
  run: vi.fn(),
}));

import { run } from "../src/shell.js";
const mockRun = vi.mocked(run);

const SESSION_ID = "test-session-pr-001";

const sampleSession: Session = {
  id: SESSION_ID,
  started_at: "2026-04-01T10:00:00.000Z",
  ended_at: "2026-04-01T10:10:00.000Z",
  cwd: "/tmp/project",
  prompt_count: 1,
  tool_call_count: 1,
  retry_count: 0,
  input_tokens: 100,
  output_tokens: 50,
  cost_usd: 0.001,
  abandoned: 0,
};

const sampleCommit: CommitRow = {
  session_id: SESSION_ID,
  sha: "abc123",
  authored_at: "2026-04-01T10:03:00.000Z",
  added_lines: 10,
  deleted_lines: 2,
};

function seedDb(): Database.Database {
  const db = openDb(":memory:");
  db.prepare(`
    INSERT INTO session (id, started_at, ended_at, cwd, prompt_count,
      tool_call_count, retry_count, input_tokens, output_tokens, cost_usd, abandoned)
    VALUES (@id, @started_at, @ended_at, @cwd, @prompt_count,
      @tool_call_count, @retry_count, @input_tokens, @output_tokens, @cost_usd, @abandoned)
  `).run(sampleSession);
  db.prepare(`
    INSERT INTO session_commit (session_id, sha, authored_at, added_lines, deleted_lines)
    VALUES (@session_id, @sha, @authored_at, @added_lines, @deleted_lines)
  `).run(sampleCommit);
  return db;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("enrichCommits", () => {
  it("writes a PR row for a merged PR", async () => {
    mockRun.mockResolvedValueOnce(JSON.stringify([{
      number: 42,
      title: "feat: add parser",
      state: "MERGED",
      mergedAt: "2026-04-01T12:00:00Z",
      url: "https://github.com/user/repo/pull/42",
    }]));

    const db = seedDb();
    await enrichCommits(db, [sampleCommit]);

    const pr = getPrForSha(db, "abc123");
    expect(pr).not.toBeUndefined();
    expect(pr!.number).toBe(42);
    expect(pr!.state).toBe("MERGED");
    expect(pr!.merged_at).toBe("2026-04-01T12:00:00Z");
    expect(pr!.reverted).toBe(0);
    expect(pr!.url).toBe("https://github.com/user/repo/pull/42");
  });

  it("sets reverted=1 when PR title contains 'revert'", async () => {
    mockRun.mockResolvedValueOnce(JSON.stringify([{
      number: 43,
      title: "Revert \"feat: add parser\"",
      state: "MERGED",
      mergedAt: "2026-04-02T09:00:00Z",
      url: "https://github.com/user/repo/pull/43",
    }]));

    const db = seedDb();
    await enrichCommits(db, [sampleCommit]);

    expect(getPrForSha(db, "abc123")!.reverted).toBe(1);
  });

  it("skips the commit when gh returns an empty array", async () => {
    mockRun.mockResolvedValueOnce(JSON.stringify([]));

    const db = seedDb();
    await enrichCommits(db, [sampleCommit]);

    expect(getPrForSha(db, "abc123")).toBeUndefined();
  });

  it("skips gracefully when gh call fails", async () => {
    mockRun.mockRejectedValueOnce(new Error("gh exited with code 1: ..."));

    const db = seedDb();
    await expect(enrichCommits(db, [sampleCommit])).resolves.toBeUndefined();
    expect(getPrForSha(db, "abc123")).toBeUndefined();
  });
});
