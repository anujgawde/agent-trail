import { run } from "./shell.js";
import { insertCommit } from "./store.js";
import type { Db, CommitRow } from "./store.js";
import type { Session } from "./jsonl-parser.js";

interface ParsedCommit {
  sha: string;
  authored_at: string;
  added_lines: number;
  deleted_lines: number;
}

function parseGitLog(output: string): ParsedCommit[] {
  if (!output.trim()) return [];

  // git log --pretty=format + --numstat produces commit blocks separated by blank lines
  const blocks = output.trim().split(/\n\n+/);
  const commits: ParsedCommit[] = [];

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    const header = lines[0];
    if (!header) continue;

    const parts = header.split("|");
    if (parts.length < 2) continue;

    const sha = parts[0]!.trim();
    const authored_at = parts[1]!.trim();

    let added_lines = 0;
    let deleted_lines = 0;

    for (const line of lines.slice(1)) {
      // numstat lines: "<added>\t<deleted>\t<filepath>"
      const cols = line.split("\t");
      if (cols.length < 2) continue;
      const added = parseInt(cols[0]!, 10);
      const deleted = parseInt(cols[1]!, 10);
      if (!isNaN(added)) added_lines += added;
      if (!isNaN(deleted)) deleted_lines += deleted;
    }

    commits.push({ sha, authored_at, added_lines, deleted_lines });
  }

  return commits;
}

export async function joinSessionToCommits(
  db: Db,
  session: Session,
): Promise<void> {
  let output: string;

  try {
    output = await run(
      "git",
      [
        "-C", session.cwd,
        "log",
        `--since=${session.started_at}`,
        `--until=${session.ended_at}`,
        "--pretty=format:%H|%aI|%s",
        "--numstat",
        "--no-merges",
      ],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // exit code 128 = not a git repo; warn and skip rather than crash
    if (msg.includes("128") || msg.includes("not a git repository")) {
      process.stderr.write(
        `[agent-trail] git-joiner: skipping session ${session.id} — ${session.cwd} is not a git repo\n`,
      );
      return;
    }
    throw err;
  }

  const commits = parseGitLog(output);

  for (const commit of commits) {
    const row: CommitRow = {
      session_id: session.id,
      sha: commit.sha,
      authored_at: commit.authored_at,
      added_lines: commit.added_lines,
      deleted_lines: commit.deleted_lines,
    };
    insertCommit(db, row);
  }
}
