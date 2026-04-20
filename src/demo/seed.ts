import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Fixture directories — prefixed so demo clean never touches real sessions
// ---------------------------------------------------------------------------

const CLAUDE_DIR = join(homedir(), ".claude", "projects");

const FIXTURES: Record<string, { dir: string; lines: object[] }> = {};

// ---------------------------------------------------------------------------
// JSONL event builder helpers
// ---------------------------------------------------------------------------

function base(
  type: string,
  sessionId: string,
  uuid: string,
  timestamp: string,
  cwd: string,
  extra: object = {},
): object {
  return {
    type,
    uuid,
    timestamp,
    parentUuid: null,
    sessionId,
    cwd,
    isSidechain: false,
    userType: "external",
    version: "2.1.0",
    gitBranch: "main",
    ...extra,
  };
}

function userPrompt(
  sessionId: string,
  uuid: string,
  timestamp: string,
  cwd: string,
  text: string,
  promptId: string,
): object {
  return base("user", sessionId, uuid, timestamp, cwd, {
    promptId,
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function toolResult(
  sessionId: string,
  uuid: string,
  timestamp: string,
  cwd: string,
  toolUseIds: string[],
): object {
  return base("user", sessionId, uuid, timestamp, cwd, {
    message: {
      role: "user",
      content: toolUseIds.map((id) => ({
        type: "tool_result",
        tool_use_id: id,
        content: "ok",
      })),
    },
  });
}

function assistantText(
  sessionId: string,
  uuid: string,
  timestamp: string,
  cwd: string,
  text: string,
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number },
  model = "claude-sonnet-4-6",
): object {
  return base("assistant", sessionId, uuid, timestamp, cwd, {
    message: {
      id: `msg_${uuid.slice(0, 8)}`,
      type: "message",
      role: "assistant",
      model,
      stop_reason: "end_turn",
      stop_sequence: null,
      content: [{ type: "text", text }],
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      },
    },
  });
}

function assistantTools(
  sessionId: string,
  uuid: string,
  timestamp: string,
  cwd: string,
  tools: Array<{ id: string; name: string; input: object }>,
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number },
  model = "claude-sonnet-4-6",
  stopReason = "tool_use",
): object {
  return base("assistant", sessionId, uuid, timestamp, cwd, {
    message: {
      id: `msg_${uuid.slice(0, 8)}`,
      type: "message",
      role: "assistant",
      model,
      stop_reason: stopReason,
      stop_sequence: null,
      content: tools.map((t) => ({
        type: "tool_use",
        id: t.id,
        name: t.name,
        input: t.input,
      })),
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      },
    },
  });
}

function toJsonl(events: object[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Scenario 1: Clean one-shot
//   1 prompt, 1 tool call, ~$0.04, merged clean
// ---------------------------------------------------------------------------

function scenario1(): { dirName: string; lines: object[] } {
  const sid = "demo-0001-0000-0000-0000-000000000001";
  const cwd = "/home/demo/clean-project";

  const events: object[] = [
    base("queue-operation", sid, "d1-u00", "2026-04-15T10:00:00.000Z", cwd),
    userPrompt(sid, "d1-u01", "2026-04-15T10:00:01.000Z", cwd,
      "Write a TypeScript function that validates an email address and add tests for it.",
      "prompt-d1-01"),
    assistantTools(sid, "d1-a01", "2026-04-15T10:00:04.000Z", cwd,
      [{ id: "tool-d1-01", name: "Write", input: { file_path: "src/validate.ts", content: "..." } }],
      { input_tokens: 6000, output_tokens: 800, cache_creation_input_tokens: 1200 }),
    toolResult(sid, "d1-u02", "2026-04-15T10:00:05.000Z", cwd, ["tool-d1-01"]),
    assistantText(sid, "d1-a02", "2026-04-15T10:02:30.000Z", cwd,
      "Done. The `validateEmail` function uses a regex pattern and I've added four unit tests covering valid addresses, missing @ symbol, missing domain, and empty string.",
      { input_tokens: 1200, output_tokens: 700, cache_read_input_tokens: 6000 }),
    base("last-prompt", sid, "d1-u03", "2026-04-15T10:02:31.000Z", cwd),
  ];

  return { dirName: "demo-clean-one-shot", lines: events };
}

// ---------------------------------------------------------------------------
// Scenario 2: Messy iteration
//   9 prompts, 22 tool calls, 3 retries, ~$2.80, merged → reverted
// ---------------------------------------------------------------------------

function scenario2(): { dirName: string; lines: object[] } {
  const sid = "demo-0002-0000-0000-0000-000000000002";
  const cwd = "/home/demo/messy-project";
  const events: object[] = [
    base("queue-operation", sid, "d2-u00", "2026-04-16T14:00:00.000Z", cwd),

    // Prompt 1 — initial ask
    userPrompt(sid, "d2-u01", "2026-04-16T14:00:01.000Z", cwd,
      "Refactor the auth module to use JWT instead of sessions.", "prompt-d2-01"),
    assistantTools(sid, "d2-a01", "2026-04-16T14:00:10.000Z", cwd,
      [{ id: "t2-01", name: "Read", input: { file_path: "src/auth.ts" } },
       { id: "t2-02", name: "Read", input: { file_path: "src/middleware.ts" } }],
      { input_tokens: 18000, output_tokens: 800, cache_creation_input_tokens: 12000 }),
    toolResult(sid, "d2-u02", "2026-04-16T14:00:11.000Z", cwd, ["t2-01", "t2-02"]),
    // RETRY — Claude immediately continues with a plan before the next user turn
    assistantText(sid, "d2-a01r", "2026-04-16T14:00:30.000Z", cwd,
      "I can see the session-based auth in auth.ts. The middleware relies on req.session throughout. This will be a multi-file change — I'll update auth.ts first, then middleware.ts.",
      { input_tokens: 22000, output_tokens: 1200, cache_read_input_tokens: 18000 }),
    assistantText(sid, "d2-a02", "2026-04-16T14:01:00.000Z", cwd, "Starting the refactor now.",
      { input_tokens: 8000, output_tokens: 200, cache_read_input_tokens: 22000 }),

    // Prompt 2
    userPrompt(sid, "d2-u03", "2026-04-16T14:01:30.000Z", cwd,
      "Also update the user model to store the JWT secret per user.", "prompt-d2-02"),
    assistantTools(sid, "d2-a03", "2026-04-16T14:01:40.000Z", cwd,
      [{ id: "t2-03", name: "Edit", input: { file_path: "src/auth.ts", old_string: "session", new_string: "jwt" } },
       { id: "t2-04", name: "Edit", input: { file_path: "src/user.ts", old_string: "sessionId", new_string: "jwtSecret" } }],
      { input_tokens: 28000, output_tokens: 1400, cache_read_input_tokens: 22000 }),
    toolResult(sid, "d2-u04", "2026-04-16T14:01:41.000Z", cwd, ["t2-03", "t2-04"]),
    assistantTools(sid, "d2-a04r", "2026-04-16T14:01:45.000Z", cwd,
      [{ id: "t2-05", name: "Edit", input: { file_path: "src/auth.ts", old_string: "old", new_string: "new" } }],
      { input_tokens: 24000, output_tokens: 800, cache_read_input_tokens: 28000 }),
    toolResult(sid, "d2-u05", "2026-04-16T14:01:46.000Z", cwd, ["t2-05"]),
    assistantText(sid, "d2-a05", "2026-04-16T14:02:30.000Z", cwd, "Auth and user model updated.",
      { input_tokens: 4000, output_tokens: 250, cache_read_input_tokens: 11000 }),

    // Prompt 3
    userPrompt(sid, "d2-u06", "2026-04-16T14:03:00.000Z", cwd,
      "The tests are failing. Fix them.", "prompt-d2-03"),
    assistantTools(sid, "d2-a06", "2026-04-16T14:03:10.000Z", cwd,
      [{ id: "t2-06", name: "Bash", input: { command: "npm test" } },
       { id: "t2-07", name: "Read", input: { file_path: "test/auth.test.ts" } }],
      { input_tokens: 15000, output_tokens: 500, cache_read_input_tokens: 14000 }),
    toolResult(sid, "d2-u07", "2026-04-16T14:03:11.000Z", cwd, ["t2-06", "t2-07"]),
    assistantTools(sid, "d2-a07", "2026-04-16T14:03:15.000Z", cwd,
      [{ id: "t2-08", name: "Edit", input: { file_path: "test/auth.test.ts", old_string: "session", new_string: "jwt" } }],
      { input_tokens: 18000, output_tokens: 400, cache_read_input_tokens: 15000 }),
    // RETRY
    assistantTools(sid, "d2-a07r", "2026-04-16T14:03:18.000Z", cwd,
      [{ id: "t2-09", name: "Bash", input: { command: "npm test" } }],
      { input_tokens: 16000, output_tokens: 200, cache_read_input_tokens: 18000 }),
    toolResult(sid, "d2-u08", "2026-04-16T14:03:20.000Z", cwd, ["t2-08", "t2-09"]),
    assistantText(sid, "d2-a08", "2026-04-16T14:05:00.000Z", cwd, "Tests fixed.",
      { input_tokens: 5000, output_tokens: 300, cache_read_input_tokens: 16000 }),

    // Prompts 4–9 (shorter exchanges)
    userPrompt(sid, "d2-u09", "2026-04-16T14:06:00.000Z", cwd, "Add a token refresh endpoint.", "prompt-d2-04"),
    assistantTools(sid, "d2-a09", "2026-04-16T14:06:10.000Z", cwd,
      [{ id: "t2-10", name: "Edit", input: { file_path: "src/routes.ts", old_string: "", new_string: "refresh" } }],
      { input_tokens: 20000, output_tokens: 500, cache_read_input_tokens: 18000 }),
    toolResult(sid, "d2-u10", "2026-04-16T14:06:11.000Z", cwd, ["t2-10"]),
    assistantText(sid, "d2-a10", "2026-04-16T14:07:00.000Z", cwd, "Refresh endpoint added.",
      { input_tokens: 6000, output_tokens: 200, cache_read_input_tokens: 20000 }),

    userPrompt(sid, "d2-u11", "2026-04-16T14:08:00.000Z", cwd, "Validate the token expiry.", "prompt-d2-05"),
    assistantTools(sid, "d2-a11", "2026-04-16T14:08:10.000Z", cwd,
      [{ id: "t2-11", name: "Edit", input: { file_path: "src/auth.ts", old_string: "x", new_string: "y" } },
       { id: "t2-12", name: "Edit", input: { file_path: "src/middleware.ts", old_string: "a", new_string: "b" } }],
      { input_tokens: 22000, output_tokens: 600, cache_read_input_tokens: 20000 }),
    toolResult(sid, "d2-u12", "2026-04-16T14:08:11.000Z", cwd, ["t2-11", "t2-12"]),
    assistantText(sid, "d2-a12", "2026-04-16T14:09:00.000Z", cwd, "Expiry validation added.",
      { input_tokens: 7000, output_tokens: 250, cache_read_input_tokens: 22000 }),

    userPrompt(sid, "d2-u13", "2026-04-16T14:10:00.000Z", cwd, "Handle the 401 errors properly.", "prompt-d2-06"),
    assistantTools(sid, "d2-a13", "2026-04-16T14:10:10.000Z", cwd,
      [{ id: "t2-13", name: "Edit", input: { file_path: "src/middleware.ts", old_string: "err", new_string: "401" } }],
      { input_tokens: 24000, output_tokens: 400, cache_read_input_tokens: 22000 }),
    // RETRY
    assistantTools(sid, "d2-a13r", "2026-04-16T14:10:14.000Z", cwd,
      [{ id: "t2-14", name: "Edit", input: { file_path: "src/error.ts", old_string: "msg", new_string: "Unauthorized" } }],
      { input_tokens: 22000, output_tokens: 300, cache_read_input_tokens: 24000 }),
    toolResult(sid, "d2-u14", "2026-04-16T14:10:15.000Z", cwd, ["t2-13", "t2-14"]),
    assistantText(sid, "d2-a14", "2026-04-16T14:11:00.000Z", cwd, "401 handling done.",
      { input_tokens: 8000, output_tokens: 200, cache_read_input_tokens: 22000 }),

    userPrompt(sid, "d2-u15", "2026-04-16T14:12:00.000Z", cwd, "Update the API docs.", "prompt-d2-07"),
    assistantTools(sid, "d2-a15", "2026-04-16T14:12:10.000Z", cwd,
      [{ id: "t2-15", name: "Write", input: { file_path: "docs/auth.md", content: "..." } },
       { id: "t2-16", name: "Write", input: { file_path: "docs/endpoints.md", content: "..." } }],
      { input_tokens: 25000, output_tokens: 800, cache_read_input_tokens: 22000 }),
    toolResult(sid, "d2-u16", "2026-04-16T14:12:11.000Z", cwd, ["t2-15", "t2-16"]),
    assistantText(sid, "d2-a16", "2026-04-16T14:13:30.000Z", cwd, "Docs updated.",
      { input_tokens: 9000, output_tokens: 300, cache_read_input_tokens: 25000 }),

    userPrompt(sid, "d2-u17", "2026-04-16T14:14:00.000Z", cwd, "Run the full test suite and fix any remaining failures.", "prompt-d2-08"),
    assistantTools(sid, "d2-a17", "2026-04-16T14:14:10.000Z", cwd,
      [{ id: "t2-17", name: "Bash", input: { command: "npm test -- --coverage" } }],
      { input_tokens: 28000, output_tokens: 400, cache_read_input_tokens: 25000 }),
    toolResult(sid, "d2-u18", "2026-04-16T14:14:12.000Z", cwd, ["t2-17"]),
    assistantTools(sid, "d2-a18", "2026-04-16T14:14:20.000Z", cwd,
      [{ id: "t2-18", name: "Edit", input: { file_path: "test/middleware.test.ts", old_string: "old", new_string: "new" } }],
      { input_tokens: 26000, output_tokens: 500, cache_read_input_tokens: 28000 }),
    toolResult(sid, "d2-u19", "2026-04-16T14:14:21.000Z", cwd, ["t2-18"]),
    assistantText(sid, "d2-a19", "2026-04-16T14:16:00.000Z", cwd, "All 47 tests passing.",
      { input_tokens: 10000, output_tokens: 350, cache_read_input_tokens: 26000 }),

    userPrompt(sid, "d2-u20", "2026-04-16T14:17:00.000Z", cwd, "Looks good. Anything else to clean up before I commit?", "prompt-d2-09"),
    assistantTools(sid, "d2-a20", "2026-04-16T14:17:10.000Z", cwd,
      [{ id: "t2-19", name: "Bash", input: { command: "npm run lint" } },
       { id: "t2-20", name: "Edit", input: { file_path: "src/auth.ts", old_string: "console.log", new_string: "" } },
       { id: "t2-21", name: "Edit", input: { file_path: "src/routes.ts", old_string: "TODO", new_string: "" } },
       { id: "t2-22", name: "Bash", input: { command: "npm run typecheck" } }],
      { input_tokens: 38000, output_tokens: 1200, cache_read_input_tokens: 32000 }),
    toolResult(sid, "d2-u21", "2026-04-16T14:17:12.000Z", cwd, ["t2-19", "t2-20", "t2-21", "t2-22"]),
    assistantText(sid, "d2-a21", "2026-04-16T14:18:30.000Z", cwd,
      "Removed debug logs and TODOs. Lint and typecheck clean. Ready to commit.",
      { input_tokens: 18000, output_tokens: 600, cache_read_input_tokens: 38000 }),
    base("last-prompt", sid, "d2-u22", "2026-04-16T14:18:31.000Z", cwd),
  ];

  return { dirName: "demo-messy-iteration", lines: events };
}

// ---------------------------------------------------------------------------
// Scenario 3: Human takeover
//   3 prompts, 5 tool calls, abandoned mid-session (stop_reason: tool_use)
// ---------------------------------------------------------------------------

function scenario3(): { dirName: string; lines: object[] } {
  const sid = "demo-0003-0000-0000-0000-000000000003";
  const cwd = "/home/demo/takeover-project";

  const events: object[] = [
    base("queue-operation", sid, "d3-u00", "2026-04-17T09:00:00.000Z", cwd),

    userPrompt(sid, "d3-u01", "2026-04-17T09:00:01.000Z", cwd,
      "Migrate the database schema to add a `deleted_at` soft-delete column to the users table.",
      "prompt-d3-01"),
    assistantTools(sid, "d3-a01", "2026-04-17T09:00:10.000Z", cwd,
      [{ id: "t3-01", name: "Read", input: { file_path: "db/schema.sql" } },
       { id: "t3-02", name: "Read", input: { file_path: "src/models/user.ts" } }],
      { input_tokens: 4000, output_tokens: 300, cache_creation_input_tokens: 2000 }),
    toolResult(sid, "d3-u02", "2026-04-17T09:00:11.000Z", cwd, ["t3-01", "t3-02"]),
    assistantText(sid, "d3-a02", "2026-04-17T09:01:00.000Z", cwd,
      "Read the schema and user model. Starting the migration.",
      { input_tokens: 2000, output_tokens: 150, cache_read_input_tokens: 4000 }),

    userPrompt(sid, "d3-u03", "2026-04-17T09:02:00.000Z", cwd,
      "Also update all the queries that fetch users to filter out soft-deleted rows.",
      "prompt-d3-02"),
    assistantTools(sid, "d3-a03", "2026-04-17T09:02:10.000Z", cwd,
      [{ id: "t3-03", name: "Edit", input: { file_path: "db/schema.sql", old_string: "id INTEGER", new_string: "id INTEGER" } },
       { id: "t3-04", name: "Edit", input: { file_path: "src/models/user.ts", old_string: "findAll", new_string: "findAll WHERE deleted_at IS NULL" } }],
      { input_tokens: 6000, output_tokens: 500, cache_read_input_tokens: 4000 }),
    toolResult(sid, "d3-u04", "2026-04-17T09:02:11.000Z", cwd, ["t3-03", "t3-04"]),
    assistantText(sid, "d3-a04", "2026-04-17T09:03:30.000Z", cwd,
      "Schema updated and queries patched. There are a few more query sites to update in the admin module.",
      { input_tokens: 3000, output_tokens: 200, cache_read_input_tokens: 6000 }),

    userPrompt(sid, "d3-u05", "2026-04-17T09:04:00.000Z", cwd,
      "Go ahead and update the admin queries too.", "prompt-d3-03"),
    // Session ends here with a tool_use — user closed the terminal mid-run
    assistantTools(sid, "d3-a05", "2026-04-17T09:04:10.000Z", cwd,
      [{ id: "t3-05", name: "Glob", input: { pattern: "src/admin/**/*.ts" } }],
      { input_tokens: 5000, output_tokens: 200, cache_read_input_tokens: 6000 },
      "claude-sonnet-4-6",
      "tool_use"), // abandoned — stop_reason stays tool_use, no tool_result follows
  ];

  return { dirName: "demo-human-takeover", lines: events };
}

// ---------------------------------------------------------------------------
// seed / clean
// ---------------------------------------------------------------------------

export function seed(): void {
  const scenarios = [scenario1(), scenario2(), scenario3()];

  for (const { dirName, lines } of scenarios) {
    const dir = join(CLAUDE_DIR, dirName);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "session.jsonl");
    writeFileSync(filePath, toJsonl(lines), "utf8");
    console.log(`  wrote ${filePath}`);
  }

  console.log("\nDemo sessions seeded. Run:\n  agent-trail ingest\n  agent-trail dashboard --open");
}

export function clean(): void {
  const prefixed = ["demo-clean-one-shot", "demo-messy-iteration", "demo-human-takeover"];

  for (const dirName of prefixed) {
    const dir = join(CLAUDE_DIR, dirName);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      console.log(`  removed ${dir}`);
    }
  }
}
