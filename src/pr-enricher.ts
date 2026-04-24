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

async function getGithubRepo(cwd: string): Promise<string | null> {
  try {
    const url = (await run("git", ["-C", cwd, "remote", "get-url", "origin"])).trim();
    // Matches both https://github.com/owner/repo.git and git@github.com:owner/repo.git
    const m = url.match(/github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?$/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

async function fetchPrForSha(sha: string, repo: string | null): Promise<GhPr | null> {
  const args = [
    "pr", "list",
    "--search", sha,
    "--state", "all",
    "--json", "number,title,state,mergedAt,url",
    "--limit", "1",
  ];
  if (repo) args.push("-R", repo);

  let output: string;
  try {
    output = await run("gh", args);
  } catch {
    process.stderr.write(
      `[agent-trail] pr-enricher: gh lookup failed for ${sha.slice(0, 7)}, skipping\n`,
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
  cwd: string,
): Promise<void> {
  const repo = await getGithubRepo(cwd);
  // Process sequentially to avoid hammering the GitHub API
  for (const commit of commits) {
    const pr = await fetchPrForSha(commit.sha, repo);
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
