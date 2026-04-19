import { program } from "commander";

program
  .name("agent-trail")
  .description(
    "Join AI coding agent sessions to git commits and PR outcomes"
  )
  .version("0.1.0");

program
  .command("ingest")
  .description("Parse local JSONL sessions, join to git commits, enrich with PR data")
  .option("--claude-dir <path>", "Claude projects directory", "~/.claude/projects")
  .option("--repo <path>", "Git repository path", ".")
  .option("--since <date>", "Only ingest sessions after this date")
  .option("--db <path>", "SQLite database path", "~/.agent-trail/db.sqlite")
  .action((opts) => {
    console.log("ingest: not yet implemented", opts);
  });

program
  .command("dashboard")
  .description("Render a static HTML dashboard from the SQLite database")
  .option("--open", "Open the dashboard in the default browser after rendering")
  .option("--out <path>", "Output HTML file path", "dashboard.html")
  .option("--db <path>", "SQLite database path", "~/.agent-trail/db.sqlite")
  .action((opts) => {
    console.log("dashboard: not yet implemented", opts);
  });

const demo = program
  .command("demo")
  .description("Manage canonical demo fixture sessions");

demo
  .command("seed")
  .description("Write three canonical JSONL fixture sessions for demo purposes")
  .action(() => {
    console.log("demo seed: not yet implemented");
  });

demo
  .command("clean")
  .description("Remove seeded demo fixture sessions")
  .action(() => {
    console.log("demo clean: not yet implemented");
  });

program
  .command("db [path]")
  .description("Print or set the SQLite database path")
  .action((path?: string) => {
    if (path) {
      console.log("db set: not yet implemented", path);
    } else {
      console.log("db get: not yet implemented");
    }
  });

program.parse();
