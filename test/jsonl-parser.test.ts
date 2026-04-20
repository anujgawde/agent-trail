import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { parseSessionFile } from "../src/jsonl-parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(join(__dirname, "fixtures", name), "utf8");

describe("parseSessionFile", () => {
  it("parses a simple two-prompt session with no tool calls", () => {
    const session = parseSessionFile(fixture("simple.jsonl"));

    expect(session).not.toBeNull();
    expect(session!.id).toBe("aaaaaaaa-0000-0000-0000-000000000001");
    expect(session!.cwd).toBe("/home/user/my-project");
    expect(session!.started_at).toBe("2026-04-01T10:00:01.000Z");
    expect(session!.ended_at).toBe("2026-04-01T10:00:10.000Z");
    expect(session!.prompt_count).toBe(2);
    expect(session!.tool_call_count).toBe(0);
    expect(session!.retry_count).toBe(0);
    expect(session!.input_tokens).toBe(300);   // 100 + 200
    expect(session!.output_tokens).toBe(60);   // 50 + 10
    expect(session!.abandoned).toBe(0);
    // cost: (300 * 3 + 60 * 15) / 1_000_000 = (900 + 900) / 1_000_000 = 0.0018
    expect(session!.cost_usd).toBeCloseTo(0.0018, 6);
  });

  it("parses a session with tool calls and counts them correctly", () => {
    const session = parseSessionFile(fixture("with-tools.jsonl"));

    expect(session).not.toBeNull();
    expect(session!.id).toBe("bbbbbbbb-0000-0000-0000-000000000002");
    expect(session!.prompt_count).toBe(2);     // two real text prompts
    expect(session!.tool_call_count).toBe(2);  // Read + Bash
    expect(session!.retry_count).toBe(0);
    expect(session!.input_tokens).toBe(390);   // 200+50+80+60
    expect(session!.output_tokens).toBe(140);  // 30+80+25+5
    expect(session!.abandoned).toBe(0);
  });

  it("skips malformed lines without throwing and still returns valid session", () => {
    const content = [
      `{"type":"user","uuid":"x","timestamp":"2026-01-01T00:00:00.000Z","parentUuid":null,"sessionId":"cccccccc-0000-0000-0000-000000000003","cwd":"/tmp","isSidechain":false,"userType":"external","version":"2.1.0","gitBranch":"main","promptId":"p1","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}`,
      `NOT VALID JSON {{{`,
      `{"type":"assistant","uuid":"y","timestamp":"2026-01-01T00:00:02.000Z","parentUuid":"x","sessionId":"cccccccc-0000-0000-0000-000000000003","cwd":"/tmp","isSidechain":false,"userType":"external","version":"2.1.0","gitBranch":"main","message":{"id":"m1","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":5}}}`,
    ].join("\n");

    const session = parseSessionFile(content);
    expect(session).not.toBeNull();
    expect(session!.prompt_count).toBe(1);
    expect(session!.input_tokens).toBe(10);
  });

  it("returns null when content has no valid user or assistant events", () => {
    const content = [
      `{"type":"progress","uuid":"p1","timestamp":"2026-01-01T00:00:00.000Z","sessionId":"dddddddd-0000-0000-0000-000000000004","cwd":"/tmp"}`,
      `{"type":"queue-operation","uuid":"p2","timestamp":"2026-01-01T00:00:01.000Z","sessionId":"dddddddd-0000-0000-0000-000000000004","cwd":"/tmp"}`,
    ].join("\n");

    expect(parseSessionFile(content)).toBeNull();
  });

  it("detects abandoned session when last event is an assistant turn", () => {
    const content = [
      `{"type":"user","uuid":"u1","timestamp":"2026-01-01T00:00:00.000Z","parentUuid":null,"sessionId":"eeeeeeee-0000-0000-0000-000000000005","cwd":"/tmp","isSidechain":false,"userType":"external","version":"2.1.0","gitBranch":"main","promptId":"p1","message":{"role":"user","content":[{"type":"text","text":"do something"}]}}`,
      `{"type":"assistant","uuid":"a1","timestamp":"2026-01-01T00:00:02.000Z","parentUuid":"u1","sessionId":"eeeeeeee-0000-0000-0000-000000000005","cwd":"/tmp","isSidechain":false,"userType":"external","version":"2.1.0","gitBranch":"main","message":{"id":"m1","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}],"stop_reason":"tool_use","stop_sequence":null,"usage":{"input_tokens":20,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":8}}}`,
    ].join("\n");

    const session = parseSessionFile(content);
    expect(session).not.toBeNull();
    expect(session!.abandoned).toBe(1);
  });
});
