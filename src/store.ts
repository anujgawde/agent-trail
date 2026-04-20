import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { Session } from "./jsonl-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Increment when schema changes — triggers re-init on next open.
const SCHEMA_VERSION = 1;

export interface CommitRow {
  session_id: string;
  sha: string;
  authored_at: string;
  added_lines: number;
  deleted_lines: number;
}

export interface PrRow {
  sha: string;
  number: number;
  state: string;
  merged_at: string | null;
  reverted: 0 | 1;
  url: string;
}

export type Db = ReturnType<typeof openDb>;

export function openDb(rawPath: string): Database.Database {
  const dbPath = rawPath.startsWith("~") ? join(homedir(), rawPath.slice(1)) : rawPath;
  if (dbPath !== ":memory:") {
    const parent = dbPath.split("/").slice(0, -1).join("/");
    if (parent) mkdirSync(parent, { recursive: true });
  }
  const require = createRequire(import.meta.url);
  const db = new (require("better-sqlite3"))(dbPath) as Database.Database;

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const version = (db.pragma("user_version", { simple: true }) as number);

  if (version < SCHEMA_VERSION) {
    const sql = readFileSync(join(__dirname, "schema.sql"), "utf8");
    db.exec(sql);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  return db;
}

export function insertSession(db: Database.Database, session: Session): void {
  db.prepare(`
    INSERT OR IGNORE INTO session
      (id, started_at, ended_at, cwd, prompt_count, tool_call_count,
       retry_count, input_tokens, output_tokens, cost_usd, abandoned)
    VALUES
      (@id, @started_at, @ended_at, @cwd, @prompt_count, @tool_call_count,
       @retry_count, @input_tokens, @output_tokens, @cost_usd, @abandoned)
  `).run(session);
}

export function insertCommit(db: Database.Database, row: CommitRow): void {
  db.prepare(`
    INSERT OR IGNORE INTO session_commit
      (session_id, sha, authored_at, added_lines, deleted_lines)
    VALUES
      (@session_id, @sha, @authored_at, @added_lines, @deleted_lines)
  `).run(row);
}

export function upsertPr(db: Database.Database, row: PrRow): void {
  db.prepare(`
    INSERT INTO pr (sha, number, state, merged_at, reverted, url)
    VALUES (@sha, @number, @state, @merged_at, @reverted, @url)
    ON CONFLICT(sha) DO UPDATE SET
      state = excluded.state,
      merged_at = excluded.merged_at,
      reverted = excluded.reverted,
      url = excluded.url
  `).run(row);
}

export function getSessions(db: Database.Database): Session[] {
  return db.prepare(`SELECT * FROM session ORDER BY started_at DESC`).all() as Session[];
}

export function getCommitsForSession(db: Database.Database, sessionId: string): CommitRow[] {
  return db.prepare(`
    SELECT * FROM session_commit WHERE session_id = ? ORDER BY authored_at ASC
  `).all(sessionId) as CommitRow[];
}

export function getPrForSha(db: Database.Database, sha: string): PrRow | undefined {
  return db.prepare(`SELECT * FROM pr WHERE sha = ?`).get(sha) as PrRow | undefined;
}
