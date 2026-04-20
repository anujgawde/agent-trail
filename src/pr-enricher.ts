import { run } from "./shell.js";
import { upsertPr } from "./store.js";
import type { Db, CommitRow, PrRow } from "./store.js";

interface GhPr {
  number: number;
  title: string;
  state: string;
  mergedAt: string | null;
  url: string;
}

export async function checkGhAuth(): Promise<void> {
  try {
    await run("gh", ["auth", "status"]);
  } catch {
    throw new Error(
      "GitHub CLI is not authenticated. Run: gh auth login",
    );
  }
}

async function fetchPrForSha(sha: string): Promise<GhPr | null> {
  let output: string;
  try {
    output = await run("gh", [
      "pr", "list",
      "--search", sha,
      "--state", "all",
      "--json", "number,title,state,mergedAt,url",
      "--limit", "1",
    ]);
  } catch {
    process.stderr.write(
      `[agent-trail] pr-enricher: gh lookup failed for ${sha}, skipping\n`,
    );
    return null;
  }

  let parsed: GhPr[];
  try {
    parsed = JSON.parse(output) as GhPr[];
  } catch {
    return null;
  }

  return parsed[0] ?? null;
}

export async function enrichCommits(
  db: Db,
  commits: CommitRow[],
): Promise<void> {
  // Process sequentially to avoid hammering the GitHub API
  for (const commit of commits) {
    const pr = await fetchPrForSha(commit.sha);
    if (!pr) continue;

    const row: PrRow = {
      sha: commit.sha,
      number: pr.number,
      state: pr.state,
      merged_at: pr.mergedAt ?? null,
      reverted: pr.title.toLowerCase().includes("revert") ? 1 : 0,
      url: pr.url,
    };

    upsertPr(db, row);
  }
}
