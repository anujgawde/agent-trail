import { readdirSync, readFileSync, statSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseSessionFile } from "./jsonl-parser.js";
import { openDb, insertSession, getCommitsForSession } from "./store.js";
import { joinSessionToCommits } from "./git-joiner.js";
import { checkGhAuth, enrichCommits } from "./pr-enricher.js";
import type { Db } from "./store.js";

export interface IngestOptions {
  claudeDir: string;
  repo: string;
  since?: string;
  db: string;
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

function findJsonlFiles(claudeDir: string): string[] {
  const files: string[] = [];
  let projectDirs: string[];

  try {
    projectDirs = readdirSync(claudeDir);
  } catch {
    throw new Error(
      `Cannot read Claude projects directory: ${claudeDir}\n` +
      `Make sure Claude Code has been used at least once, or pass --claude-dir with the correct path.`,
    );
  }

  for (const projectDir of projectDirs) {
    const projectPath = join(claudeDir, projectDir);
    try {
      if (!statSync(projectPath).isDirectory()) continue;
    } catch {
      continue;
    }

    // Claude Code writes session files directly in the project dir
    const entries = readdirSync(projectPath).filter((f) => f.endsWith(".jsonl"));
    for (const entry of entries) {
      files.push(join(projectPath, entry));
    }
  }

  return files;
}

function parseDbPath(dbPath: string): string {
  const expanded = expandHome(dbPath);
  // Ensure parent directory exists
  const parent = expanded.split("/").slice(0, -1).join("/");
  if (parent) mkdirSync(parent, { recursive: true });
  return expanded;
}

export async function runIngest(opts: IngestOptions): Promise<void> {
  const claudeDir = expandHome(opts.claudeDir);
  const repoPath = resolve(opts.repo);
  const dbPath = parseDbPath(opts.db);
  const sinceDate = opts.since ? new Date(opts.since) : null;

  if (sinceDate && isNaN(sinceDate.getTime())) {
    throw new Error(`Invalid --since date: "${opts.since}". Use ISO-8601 format, e.g. 2026-01-01`);
  }

  console.log(`[agent-trail] Opening database: ${dbPath}`);
  const db: Db = openDb(dbPath);

  console.log(`[agent-trail] Scanning for sessions in: ${claudeDir}`);
  const files = findJsonlFiles(claudeDir);

  if (files.length === 0) {
    console.log(
      `No JSONL session files found in ${claudeDir}.\n` +
      `Try running: agent-trail demo seed`,
    );
    return;
  }

  console.log(`[agent-trail] Found ${files.length} session file(s)`);

  // Check gh auth once upfront — warn but don't abort if missing
  let ghAvailable = true;
  try {
    await checkGhAuth();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[agent-trail] Warning: ${msg}\nPR enrichment will be skipped.\n`);
    ghAvailable = false;
  }

  let parsed = 0;
  let skipped = 0;
  let enriched = 0;

  for (const filePath of files) {
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      process.stderr.write(`[agent-trail] Cannot read ${filePath}, skipping\n`);
      skipped++;
      continue;
    }

    const session = parseSessionFile(content);
    if (!session) {
      skipped++;
      continue;
    }

    // Apply --since filter
    if (sinceDate && new Date(session.started_at) < sinceDate) {
      skipped++;
      continue;
    }

    insertSession(db, session);

    // Override cwd with --repo if the session cwd doesn't exist or isn't a git repo
    const effectiveCwd = session.cwd ?? repoPath;
    await joinSessionToCommits(db, { ...session, cwd: effectiveCwd });

    if (ghAvailable) {
      const commits = getCommitsForSession(db, session.id);
      if (commits.length > 0) {
        await enrichCommits(db, commits);
        enriched += commits.length;
      }
    }

    parsed++;
    console.log(
      `  [${parsed}] ${session.id.slice(0, 8)}… ` +
      `prompts=${session.prompt_count} tools=${session.tool_call_count} ` +
      `cost=$${session.cost_usd.toFixed(4)}`,
    );
  }

  console.log(
    `\n[agent-trail] Done. ` +
    `parsed=${parsed} skipped=${skipped} commits_enriched=${enriched}`,
  );
  console.log(`Run: agent-trail dashboard --open`);
}
