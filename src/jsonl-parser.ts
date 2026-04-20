/*
 * Claude Code JSONL schema (observed 2026-04, Claude Code v2.1+)
 *
 * Each line is a JSON object. Relevant event types:
 *
 * "user"      — a human turn or tool-result reply
 *   .sessionId   string   UUID, same across all events in the file
 *   .timestamp   string   ISO-8601
 *   .cwd         string   working directory for the session
 *   .promptId?   string   present only on real human prompts, absent on tool-result replies
 *   .message.role     "user"
 *   .message.content  array of blocks:
 *     { type: "text", text: string }           — real human prompt
 *     { type: "tool_result", tool_use_id, content }  — tool response (no promptId)
 *
 * "assistant" — a Claude response
 *   .message.role     "assistant"
 *   .message.model    string  e.g. "claude-sonnet-4-6"
 *   .message.content  array of blocks:
 *     { type: "text", text: string }
 *     { type: "tool_use", id, name, input }
 *     { type: "thinking", thinking: string }   — extended thinking (skip for counts)
 *   .message.usage.input_tokens               number
 *   .message.usage.output_tokens              number
 *   .message.usage.cache_creation_input_tokens number
 *   .message.usage.cache_read_input_tokens    number
 *
 * All other types (queue-operation, file-history-snapshot, ai-title,
 * last-prompt, attachment, progress, etc.) are skipped.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const ContentBlockSchema = z
  .object({ type: z.string() })
  .passthrough();

const UserEventSchema = z
  .object({
    type: z.literal("user"),
    sessionId: z.string(),
    timestamp: z.string(),
    cwd: z.string(),
    promptId: z.string().optional(),
    message: z.object({
      role: z.literal("user"),
      content: z.union([z.string(), z.array(ContentBlockSchema)]),
    }),
  })
  .passthrough();

const AssistantEventSchema = z
  .object({
    type: z.literal("assistant"),
    sessionId: z.string(),
    timestamp: z.string(),
    cwd: z.string(),
    message: z.object({
      role: z.literal("assistant"),
      model: z.string(),
      stop_reason: z.string().nullable().optional(),
      content: z.array(ContentBlockSchema),
      usage: z.object({
        input_tokens: z.number(),
        output_tokens: z.number(),
        cache_creation_input_tokens: z.number().default(0),
        cache_read_input_tokens: z.number().default(0),
      }),
    }).passthrough(),
  })
  .passthrough();

// Catch-all for unknown event types — parse but discard
const UnknownEventSchema = z.object({ type: z.string() }).passthrough();

// ---------------------------------------------------------------------------
// Pricing table (USD per million tokens)
// ---------------------------------------------------------------------------

interface ModelRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const PRICING: Array<[prefix: string, rates: ModelRates]> = [
  ["claude-opus",    { input: 15,   output: 75,  cacheRead: 1.50,  cacheWrite: 18.75 }],
  ["claude-sonnet",  { input: 3,    output: 15,  cacheRead: 0.30,  cacheWrite: 3.75  }],
  ["claude-haiku",   { input: 0.80, output: 4,   cacheRead: 0.08,  cacheWrite: 1.00  }],
];

const SONNET_RATES = PRICING[1]![1];

function getRates(model: string): ModelRates {
  for (const [prefix, rates] of PRICING) {
    if (model.startsWith(prefix)) return rates;
  }
  return SONNET_RATES;
}

function computeCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): number {
  const r = getRates(model);
  return (
    (inputTokens * r.input +
      outputTokens * r.output +
      cacheReadTokens * r.cacheRead +
      cacheWriteTokens * r.cacheWrite) /
    1_000_000
  );
}

// ---------------------------------------------------------------------------
// Session type
// ---------------------------------------------------------------------------

export interface Session {
  id: string;
  started_at: string;
  ended_at: string;
  cwd: string;
  prompt_count: number;
  tool_call_count: number;
  retry_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  abandoned: 0 | 1;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseSessionFile(content: string): Session | null {
  const lines = content.split("\n").filter((l) => l.trim() !== "");

  let sessionId: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let cwd: string | null = null;

  let promptCount = 0;
  let toolCallCount = 0;
  let retryCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let lastModel = "claude-sonnet-4-6";

  let prevWasAssistant = false;
  let lastAssistantStopReason: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      process.stderr.write(`[agent-trail] jsonl-parser: malformed JSON on line ${i + 1}, skipping\n`);
      continue;
    }

    const base = UnknownEventSchema.safeParse(parsed);
    if (!base.success) continue;

    const eventType = base.data["type"] as string;

    if (eventType === "user") {
      const result = UserEventSchema.safeParse(parsed);
      if (!result.success) continue;
      const ev = result.data;

      if (!sessionId) {
        sessionId = ev.sessionId;
        cwd = ev.cwd;
      }
      if (!startedAt) startedAt = ev.timestamp;
      endedAt = ev.timestamp;

      const contentBlocks = Array.isArray(ev.message.content)
        ? ev.message.content
        : [];

      const isRealPrompt = contentBlocks.some((b) => b["type"] === "text");
      if (isRealPrompt) promptCount++;

      prevWasAssistant = false;
    } else if (eventType === "assistant") {
      const result = AssistantEventSchema.safeParse(parsed);
      if (!result.success) continue;
      const ev = result.data;

      if (!sessionId) {
        sessionId = ev.sessionId;
        cwd = ev.cwd;
      }
      if (!startedAt) startedAt = ev.timestamp;
      endedAt = ev.timestamp;

      // Consecutive assistant events = retry
      if (prevWasAssistant) retryCount++;
      prevWasAssistant = true;

      const toolUseBlocks = ev.message.content.filter(
        (b) => b["type"] === "tool_use",
      );
      toolCallCount += toolUseBlocks.length;

      const usage = ev.message.usage;
      inputTokens += usage.input_tokens;
      outputTokens += usage.output_tokens;
      cacheReadTokens += usage.cache_read_input_tokens;
      cacheWriteTokens += usage.cache_creation_input_tokens;
      lastModel = ev.message.model;
      lastAssistantStopReason = ev.message.stop_reason ?? null;
    } else {
      prevWasAssistant = false;
    }
  }

  if (!sessionId || !startedAt || !endedAt || !cwd) return null;

  const costUsd = computeCost(
    lastModel,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  );

  // Session is abandoned if the last assistant turn was still waiting for a tool
  // result (stop_reason "tool_use") — meaning the user closed mid-session.
  const abandoned: 0 | 1 = lastAssistantStopReason === "tool_use" ? 1 : 0;

  return {
    id: sessionId,
    started_at: startedAt,
    ended_at: endedAt,
    cwd,
    prompt_count: promptCount,
    tool_call_count: toolCallCount,
    retry_count: retryCount,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: costUsd,
    abandoned,
  };
}
