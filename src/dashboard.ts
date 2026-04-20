import Handlebars from "handlebars";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { getSessions, getCommitsForSession, getPrForSha } from "./store.js";
import type { Db, CommitRow, PrRow } from "./store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Handlebars helpers
// ---------------------------------------------------------------------------

Handlebars.registerHelper("eq", (a: unknown, b: unknown) => a === b);

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
    hour12: false,
  });
}

function fmtDuration(startIso: string, endIso: string): string {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  const totalSec = Math.round(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

// ---------------------------------------------------------------------------
// View-model types
// ---------------------------------------------------------------------------

interface CommitViewModel {
  sha_short: string;
  authored_fmt: string;
  added_lines: number;
  deleted_lines: number;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: string | null;
  reverted: boolean;
}

interface SessionViewModel {
  id: string;
  started_at_fmt: string;
  project: string;
  cwd: string;
  duration: string;
  prompt_count: number;
  tool_call_count: number;
  retry_count: number;
  cost_fmt: string;
  cost_pct: number;
  abandoned: boolean;
  outcome_merged: boolean;
  outcome_reverted: boolean;
  outcome_open: boolean;
  commits: CommitViewModel[];
}

interface ChartBar {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface DashboardViewModel {
  generatedAt: string;
  headline: {
    costPerMergedLine: string;
    totalCost: string;
    totalSessions: number;
    mergedPrs: number;
    revertedPrs: number;
  };
  chart: {
    bars: ChartBar[];
    width: number;
  };
  sessions: SessionViewModel[];
}

// ---------------------------------------------------------------------------
// Build view model
// ---------------------------------------------------------------------------

function buildViewModel(db: Db): DashboardViewModel {
  const sessions = getSessions(db);

  let totalCost = 0;
  let totalMergedLines = 0;
  let mergedPrs = 0;
  let revertedPrs = 0;

  const sessionVMs: SessionViewModel[] = sessions.map((session) => {
    const commits: CommitRow[] = getCommitsForSession(db, session.id);

    let sessionMerged = false;
    let sessionReverted = false;
    let sessionOpen = false;

    const commitVMs: CommitViewModel[] = commits.map((commit) => {
      const pr: PrRow | undefined = getPrForSha(db, commit.sha);

      if (pr) {
        if (pr.reverted) {
          sessionReverted = true;
          revertedPrs++;
        } else if (pr.state === "MERGED") {
          sessionMerged = true;
          mergedPrs++;
          totalMergedLines += commit.added_lines;
        } else if (pr.state === "OPEN") {
          sessionOpen = true;
        }
      }

      return {
        sha_short: commit.sha.slice(0, 7),
        authored_fmt: fmtDate(commit.authored_at),
        added_lines: commit.added_lines,
        deleted_lines: commit.deleted_lines,
        pr_number: pr?.number ?? null,
        pr_url: pr?.url ?? null,
        pr_state: pr?.state ?? null,
        reverted: pr?.reverted === 1,
      };
    });

    totalCost += session.cost_usd;

    return {
      id: session.id,
      started_at_fmt: fmtDate(session.started_at),
      project: basename(session.cwd),
      cwd: session.cwd,
      duration: fmtDuration(session.started_at, session.ended_at),
      prompt_count: session.prompt_count,
      tool_call_count: session.tool_call_count,
      retry_count: session.retry_count,
      cost_fmt: fmtCost(session.cost_usd),
      cost_pct: 0, // filled in below after max is known
      abandoned: session.abandoned === 1,
      outcome_merged: sessionMerged && !sessionReverted,
      outcome_reverted: sessionReverted,
      outcome_open: sessionOpen,
      commits: commitVMs,
    };
  });

  // Compute cost bar percentages
  const maxCost = Math.max(...sessions.map((s) => s.cost_usd), 0.000001);
  for (const vm of sessionVMs) {
    const raw = sessions.find((s) => s.id === vm.id)?.cost_usd ?? 0;
    vm.cost_pct = Math.round((raw / maxCost) * 100);
  }

  // Build SVG bar chart data
  const chartWidth = 900;
  const chartHeight = 100;
  const barGap = 4;
  const n = sessionVMs.length;
  const barW = n > 0 ? Math.max(4, Math.floor((chartWidth - barGap * (n - 1)) / n)) : 0;
  const bars: ChartBar[] = sessionVMs.map((vm, i) => {
    const h = Math.max(4, Math.round((vm.cost_pct / 100) * chartHeight));
    return {
      x: i * (barW + barGap),
      y: chartHeight - h,
      w: barW,
      h,
    };
  });

  const costPerMergedLine =
    totalMergedLines > 0
      ? `$${(totalCost / totalMergedLines).toFixed(4)}`
      : "—";

  return {
    generatedAt: new Date().toLocaleString("en-US", {
      month: "short", day: "numeric", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }),
    headline: {
      costPerMergedLine,
      totalCost: fmtCost(totalCost),
      totalSessions: sessions.length,
      mergedPrs,
      revertedPrs,
    },
    chart: { bars, width: chartWidth },
    sessions: sessionVMs,
  };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export async function renderDashboard(
  db: Db,
  outPath: string,
  open: boolean,
): Promise<void> {
  const templateSrc = readFileSync(
    join(__dirname, "templates", "dashboard.hbs"),
    "utf8",
  );
  const template = Handlebars.compile(templateSrc);
  const viewModel = buildViewModel(db);
  const html = template(viewModel);

  writeFileSync(outPath, html, "utf8");
  console.log(`Dashboard written to ${outPath}`);

  if (open) {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    await execa(opener, [outPath]);
  }
}
