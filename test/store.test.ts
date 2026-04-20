import { describe, it, expect, beforeEach } from "vitest";
import { openDb, insertSession, insertCommit, upsertPr, getSessions, getCommitsForSession, getPrForSha } from "../src/store.js";
import type { Session } from "../src/jsonl-parser.js";
import type { CommitRow, PrRow } from "../src/store.js";
import Database from "better-sqlite3";

const sampleSession: Session = {
  id: "test-session-001",
  started_at: "2026-04-01T10:00:00.000Z",
  ended_at: "2026-04-01T10:05:00.000Z",
  cwd: "/home/user/project",
  prompt_count: 3,
  tool_call_count: 5,
  retry_count: 1,
  input_tokens: 1000,
  output_tokens: 500,
  cost_usd: 0.0105,
  abandoned: 0,
};

const sampleCommit: CommitRow = {
  session_id: "test-session-001",
  sha: "abc123def456",
  authored_at: "2026-04-01T10:03:00.000Z",
  added_lines: 42,
  deleted_lines: 7,
};

const samplePr: PrRow = {
  sha: "abc123def456",
  number: 99,
  state: "MERGED",
  merged_at: "2026-04-01T11:00:00.000Z",
  reverted: 0,
  url: "https://github.com/user/project/pull/99",
};

let db: Database.Database;

beforeEach(() => {
  db = openDb(":memory:");
});

describe("store", () => {
  it("inserts and retrieves a session", () => {
    insertSession(db, sampleSession);
    const sessions = getSessions(db);
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.id).toBe(sampleSession.id);
    expect(s.prompt_count).toBe(3);
    expect(s.cost_usd).toBeCloseTo(0.0105, 6);
    expect(s.abandoned).toBe(0);
  });

  it("INSERT OR IGNORE prevents duplicates on re-ingest", () => {
    insertSession(db, sampleSession);
    insertSession(db, sampleSession);
    expect(getSessions(db)).toHaveLength(1);
  });

  it("inserts and retrieves a commit row", () => {
    insertSession(db, sampleSession);
    insertCommit(db, sampleCommit);
    const commits = getCommitsForSession(db, "test-session-001");
    expect(commits).toHaveLength(1);
    expect(commits[0]!.sha).toBe("abc123def456");
    expect(commits[0]!.added_lines).toBe(42);
  });

  it("upserts a PR row and updates state on conflict", () => {
    upsertPr(db, samplePr);
    expect(getPrForSha(db, "abc123def456")!.state).toBe("MERGED");

    upsertPr(db, { ...samplePr, state: "CLOSED", reverted: 1 });
    const pr = getPrForSha(db, "abc123def456")!;
    expect(pr.state).toBe("CLOSED");
    expect(pr.reverted).toBe(1);
  });

  it("returns undefined for a PR sha that does not exist", () => {
    expect(getPrForSha(db, "nonexistent")).toBeUndefined();
  });
});
