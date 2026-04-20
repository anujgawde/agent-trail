import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { describe, it, expect, beforeAll } from "vitest";
import { openDb, getCommitsForSession } from "../src/store.js";
import { joinSessionToCommits } from "../src/git-joiner.js";
import type { Session } from "../src/jsonl-parser.js";
import Database from "better-sqlite3";

let repoDir: string;
let commitSha: string;

const SESSION_START = "2026-04-01T10:00:00.000Z";
const SESSION_END   = "2026-04-01T10:10:00.000Z";
const COMMIT_TIME   = "2026-04-01T10:03:00+00:00";

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), "agent-trail-test-"));

  execSync("git init", { cwd: repoDir });
  execSync("git config user.email 'test@test.com'", { cwd: repoDir });
  execSync("git config user.name 'Test'", { cwd: repoDir });

  writeFileSync(join(repoDir, "hello.ts"), "export const x = 1\n");
  execSync("git add .", { cwd: repoDir });
  execSync('git commit -m "test: initial commit"', {
    cwd: repoDir,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: COMMIT_TIME,
      GIT_COMMITTER_DATE: COMMIT_TIME,
    },
  });

  commitSha = execSync("git rev-parse HEAD", { cwd: repoDir })
    .toString()
    .trim();
});

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-session-git-001",
    started_at: SESSION_START,
    ended_at: SESSION_END,
    cwd: repoDir,
    prompt_count: 1,
    tool_call_count: 1,
    retry_count: 0,
    input_tokens: 100,
    output_tokens: 50,
    cost_usd: 0.001,
    abandoned: 0,
    ...overrides,
  };
}

describe("joinSessionToCommits", () => {
  it("writes a commit row when the commit falls inside the session window", async () => {
    const db: Database.Database = openDb(":memory:");
    const session = makeSession();

    // insertSession first so foreign key constraint is satisfied
    db.prepare(`
      INSERT INTO session (id, started_at, ended_at, cwd, prompt_count,
        tool_call_count, retry_count, input_tokens, output_tokens, cost_usd, abandoned)
      VALUES (@id, @started_at, @ended_at, @cwd, @prompt_count,
        @tool_call_count, @retry_count, @input_tokens, @output_tokens, @cost_usd, @abandoned)
    `).run(session);

    await joinSessionToCommits(db, session);

    const commits = getCommitsForSession(db, session.id);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.sha).toBe(commitSha);
    expect(commits[0]!.added_lines).toBe(1);
    expect(commits[0]!.deleted_lines).toBe(0);
  });

  it("writes no rows when the session window excludes the commit", async () => {
    const db: Database.Database = openDb(":memory:");
    const session = makeSession({
      id: "test-session-git-002",
      started_at: "2026-04-02T00:00:00.000Z",
      ended_at: "2026-04-02T01:00:00.000Z",
    });

    db.prepare(`
      INSERT INTO session (id, started_at, ended_at, cwd, prompt_count,
        tool_call_count, retry_count, input_tokens, output_tokens, cost_usd, abandoned)
      VALUES (@id, @started_at, @ended_at, @cwd, @prompt_count,
        @tool_call_count, @retry_count, @input_tokens, @output_tokens, @cost_usd, @abandoned)
    `).run(session);

    await joinSessionToCommits(db, session);

    expect(getCommitsForSession(db, session.id)).toHaveLength(0);
  });

  it("skips gracefully when cwd is not a git repository", async () => {
    const db: Database.Database = openDb(":memory:");
    const session = makeSession({
      id: "test-session-git-003",
      cwd: tmpdir(),
    });

    db.prepare(`
      INSERT INTO session (id, started_at, ended_at, cwd, prompt_count,
        tool_call_count, retry_count, input_tokens, output_tokens, cost_usd, abandoned)
      VALUES (@id, @started_at, @ended_at, @cwd, @prompt_count,
        @tool_call_count, @retry_count, @input_tokens, @output_tokens, @cost_usd, @abandoned)
    `).run(session);

    await expect(joinSessionToCommits(db, session)).resolves.toBeUndefined();
    expect(getCommitsForSession(db, session.id)).toHaveLength(0);
  });
});
