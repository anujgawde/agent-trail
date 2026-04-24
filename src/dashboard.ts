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
  cost_raw: number;
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
  cost: string;
  date: string;
}

interface DirectoryViewModel {
  dirId: string;
  cwd: string;
  project: string;
  sessionCount: number;
  totalCost: string;
  mergedPrs: number;
  revertedPrs: number;
  abandonedCount: number;
  openPrs: number;
  sessions: SessionViewModel[];
  chart: { bars: ChartBar[]; width: number; maxCostFmt: string };
}

interface DashboardViewModel {
  generatedAt: string;
  headline: {
    costPerMergedLine: string;
    costPerMergedLineAvailable: boolean;
    totalCost: string;
    avgCostPerSession: string;
    totalSessions: number;
    mergedPrs: number;
    revertedPrs: number;
    directoryCount: number;
    totalToolCalls: number;
    totalPrompts: number;
  };
  chart: {
    bars: ChartBar[];
    width: number;
    maxCostFmt: string;
  };
  sessions: SessionViewModel[];
  directories: DirectoryViewModel[];
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
      cost_raw: session.cost_usd,
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

  // Build SVG bar chart data — only sessions with actual spend get a bar
  const chartWidth = 900;
  const chartHeight = 100;
  const barGap = 4;
  const maxSessionCost = Math.max(...sessions.map((s) => s.cost_usd), 0);
  const sessionVMsWithCost = sessionVMs.filter((vm) => vm.cost_raw > 0);
  const n = sessionVMsWithCost.length;
  const barW = n > 0 ? Math.max(4, Math.floor((chartWidth - barGap * (n - 1)) / n)) : 0;
  const bars: ChartBar[] = sessionVMsWithCost.map((vm, i) => {
    const h = Math.max(1, Math.round((vm.cost_raw / maxSessionCost) * chartHeight));
    return { x: i * (barW + barGap), y: chartHeight - h, w: barW, h, cost: vm.cost_fmt, date: vm.started_at_fmt };
  });

  // Group sessions by cwd → directory view models
  const dirMap = new Map<string, SessionViewModel[]>();
  for (const vm of sessionVMs) {
    const arr = dirMap.get(vm.cwd) ?? [];
    arr.push(vm);
    dirMap.set(vm.cwd, arr);
  }

  const directories: DirectoryViewModel[] = Array.from(dirMap.entries()).map(
    ([cwd, dirSessions], i) => {
      const dirCostRaw = dirSessions.reduce((s, vm) => s + vm.cost_raw, 0);
      const dirMerged = dirSessions.filter((vm) => vm.outcome_merged).length;
      const dirReverted = dirSessions.filter((vm) => vm.outcome_reverted).length;
      const dirAbandoned = dirSessions.filter((vm) => vm.abandoned).length;
      const dirOpen = dirSessions.filter((vm) => vm.outcome_open).length;

      const actualMaxDirCost = Math.max(...dirSessions.map((vm) => vm.cost_raw), 0);
      const maxDirCost = Math.max(actualMaxDirCost, 0.000001);
      const dirSessionsWithCost = dirSessions.filter((vm) => vm.cost_raw > 0);
      const dn = dirSessionsWithCost.length;
      // Cap bar width at 48px; bars sit in the full 900px viewBox so the chart always fills the container
      const dBarW = Math.min(48, dn > 0 ? Math.max(4, Math.floor((chartWidth - barGap * (dn - 1)) / dn)) : 0);
      const dirBars: ChartBar[] = dirSessionsWithCost.map((vm, j) => {
        const h = Math.max(1, Math.round((vm.cost_raw / maxDirCost) * chartHeight));
        return { x: j * (dBarW + barGap), y: chartHeight - h, w: dBarW, h, cost: vm.cost_fmt, date: vm.started_at_fmt };
      });

      return {
        dirId: `dir-${i}`,
        cwd,
        project: basename(cwd),
        sessionCount: dirSessions.length,
        totalCost: fmtCost(dirCostRaw),
        mergedPrs: dirMerged,
        revertedPrs: dirReverted,
        abandonedCount: dirAbandoned,
        openPrs: dirOpen,
        sessions: dirSessions,
        chart: { bars: dirBars, width: chartWidth, maxCostFmt: fmtCost(actualMaxDirCost) },
      };
    },
  );

  const costPerMergedLine =
    totalMergedLines > 0
      ? `$${(totalCost / totalMergedLines).toFixed(4)}`
      : "—";

  const totalToolCalls = sessions.reduce((s, r) => s + r.tool_call_count, 0);
  const totalPrompts = sessions.reduce((s, r) => s + r.prompt_count, 0);

  return {
    generatedAt: new Date().toLocaleString("en-US", {
      month: "short", day: "numeric", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }),
    headline: {
      costPerMergedLine,
      costPerMergedLineAvailable: totalMergedLines > 0,
      totalCost: fmtCost(totalCost),
      avgCostPerSession: sessions.length > 0 ? fmtCost(totalCost / sessions.length) : "—",
      totalSessions: sessions.length,
      mergedPrs,
      revertedPrs,
      directoryCount: directories.length,
      totalToolCalls,
      totalPrompts,
    },
    chart: { bars, width: chartWidth, maxCostFmt: fmtCost(maxSessionCost) },
    sessions: sessionVMs,
    directories,
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
