PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  cwd TEXT NOT NULL,
  prompt_count INTEGER NOT NULL,
  tool_call_count INTEGER NOT NULL,
  retry_count INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  abandoned INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS session_commit (
  session_id TEXT NOT NULL REFERENCES session(id),
  sha TEXT NOT NULL,
  authored_at TEXT NOT NULL,
  added_lines INTEGER NOT NULL,
  deleted_lines INTEGER NOT NULL,
  PRIMARY KEY (session_id, sha)
);

CREATE TABLE IF NOT EXISTS pr (
  sha TEXT PRIMARY KEY,
  number INTEGER NOT NULL,
  state TEXT NOT NULL,
  merged_at TEXT,
  reverted INTEGER NOT NULL DEFAULT 0,
  url TEXT NOT NULL
);
