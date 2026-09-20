import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { compactWithWarmPrefix, compactionInstruction, type CompleteSummary } from "../src/cache-friendly-compaction.js";
import type { CompactionPlan } from "../src/compaction.js";

const usage = { input: 100, output: 20, cacheRead: 900, cacheWrite: 0, totalTokens: 1020,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { id: "m", name: "Model", api: "openai-responses", provider: "p", baseUrl: "https://example.invalid",
  reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 } as Model<any>;

function fixture() {
  const prefix = [
    { role: "user", content: "Fix src/auth.ts", timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "inspect", thinkingSignature: "signed" }, { type: "text", text: "I found the race." }],
      api: "openai-responses", provider: "p", model: "m", usage, stopReason: "stop", timestamp: 2 },
  ] as any[];
  const preparation = { firstKeptEntryId: "keep", messagesToSummarize: prefix, turnPrefixMessages: [], isSplitTurn: false,
    tokensBefore: 50000, fileOps: { read: new Set(), written: new Set(), edited: new Set() }, settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 } };
  const event = { type: "session_before_compact", preparation, branchEntries: [], reason: "threshold", willRetry: false,
    customInstructions: "keep the auth invariant", signal: new AbortController().signal } as unknown as SessionBeforeCompactEvent;
  const plan = { version: 1, reason: event.reason, firstKeptEntryId: "keep", tokensBefore: 50000, isSplitTurn: false,
    summarizedMessageCount: 2, retainedPrefixMessageCount: 0, pruned: [], charsRemoved: 0,
    standalonePlanning: { mode: "shadow" }, preparation } as unknown as CompactionPlan;
  const pi = {
    getActiveTools: () => ["edit", "read"],
    getAllTools: () => [
      { name: "read", description: "Read", parameters: { type: "object" }, promptGuidelines: [], sourceInfo: {} },
      { name: "edit", description: "Edit", parameters: { type: "object" }, promptGuidelines: [], sourceInfo: {} },
      { name: "unused", description: "Unused", parameters: { type: "object" }, promptGuidelines: [], sourceInfo: {} },
    ],
    getThinkingLevel: () => "high",
  } as any;
  const ctx = {
    model,
    getSystemPrompt: () => "stable system prompt",
    sessionManager: { getSessionId: () => "stable-session" },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: { "x-route": "same" } }) },
  } as unknown as ExtensionContext;
  return { prefix, event, plan, pi, ctx };
}

function response(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage, stopReason, timestamp: 3 };
}

test("warm-prefix compaction replays Prime messages and envelope before one trailing instruction", async () => {
  const f = fixture();
  const before = JSON.stringify(f.prefix);
  (f.plan as any).preparation = { ...f.plan.preparation, messagesToSummarize: [{ role: "user", content: "PRUNED PLAN MUST NOT BE SENT", timestamp: 1 }] };
  let captured: { context: Context; options: SimpleStreamOptions } | undefined;
  const complete: CompleteSummary = async (_model, context, options) => {
    captured = { context, options };
    return response([{ type: "thinking", thinking: "summarize" }, { type: "text", text: "Resume with the auth race fix." }]);
  };
  const result = await compactWithWarmPrefix(f.pi, f.event, f.ctx, f.plan, complete);
  assert.equal(JSON.stringify(f.prefix), before);
  assert.equal(captured?.context.systemPrompt, "stable system prompt");
  assert.deepEqual(captured?.context.messages.slice(0, 2), f.prefix);
  const trailing = captured?.context.messages.at(-1);
  assert.equal(trailing?.role, "user");
  assert.equal(typeof trailing?.content, "string");
  if (typeof trailing?.content === "string") assert.match(trailing.content, /keep the auth invariant/);
  assert.deepEqual(captured?.context.tools?.map((tool) => tool.name), ["edit", "read"]);
  assert.equal(captured?.options.sessionId, "stable-session");
  assert.equal(captured?.options.cacheRetention, "short");
  assert.equal(captured?.options.apiKey, "test-key");
  assert.deepEqual(captured?.options.headers, { "x-route": "same" });
  assert.equal(captured?.options.reasoning, "high");
  assert.equal(captured?.options.maxTokens, 4096);
  assert.equal(result.summary, "Resume with the auth race fix.");
  assert.equal(result.firstKeptEntryId, "keep");
  assert.equal(result.usage?.cacheRead, 900);
  assert.equal(result.details?.engine, "dsh-warm-prefix-v1");
});

test("warm-prefix compaction rejects incomplete output and tool calls", async () => {
  const f = fixture();
  await assert.rejects(() => compactWithWarmPrefix(f.pi, f.event, f.ctx, f.plan, async () => response([{ type: "text", text: "partial" }], "length")), /token limit/);
  await assert.rejects(() => compactWithWarmPrefix(f.pi, f.event, f.ctx, f.plan, async () => response([{ type: "toolCall", id: "x", name: "read", arguments: {} }])), /attempted a tool call/);
});

test("warm-prefix compaction fails before dispatch on unpaired tools", async () => {
  const f = fixture();
  (f.plan.preparation.messagesToSummarize as any[]).push({ role: "assistant", content: [{ type: "toolCall", id: "open", name: "read", arguments: {} }],
    api: "openai-responses", provider: "p", model: "m", usage, stopReason: "toolUse", timestamp: 4 });
  let called = false;
  await assert.rejects(() => compactWithWarmPrefix(f.pi, f.event, f.ctx, f.plan, async () => { called = true; return response([{ type: "text", text: "x" }]); }), /unanswered tool call/);
  assert.equal(called, false);
});

test("compaction instruction is deterministic and appends optional focus", () => {
  assert.equal(compactionInstruction(), compactionInstruction("  "));
  assert.match(compactionInstruction("files only"), /"additionalFocus":"files only"/);
});

test("warm-prefix compaction fails closed on missing active tool definitions", async () => {
  const f = fixture();
  f.pi.getActiveTools = () => ["missing"];
  await assert.rejects(() => compactWithWarmPrefix(f.pi, f.event, f.ctx, f.plan, async () => response([{ type: "text", text: "x" }])), /definition is unavailable/);
});

test("warm-prefix compaction rejects tool calls crossing a user boundary", async () => {
  const f = fixture();
  f.event.preparation.messagesToSummarize = [
    { role: "assistant", content: [{ type: "toolCall", id: "open", name: "read", arguments: {} }], api: "openai-responses", provider: "p", model: "m", usage, stopReason: "toolUse", timestamp: 1 },
    { role: "user", content: "continue", timestamp: 2 },
  ] as any;
  await assert.rejects(() => compactWithWarmPrefix(f.pi, f.event, f.ctx, f.plan, async () => response([{ type: "text", text: "x" }])), /crosses a message boundary/);
});

test("warm-prefix compaction rejects non-stop responses and stale source", async () => {
  const f = fixture();
  await assert.rejects(() => compactWithWarmPrefix(f.pi, f.event, f.ctx, f.plan, async () => response([{ type: "text", text: "x" }], "toolUse")), /toolUse/);
  let leaf = "leaf-a";
  (f.ctx as any).sessionManager = { getSessionId: () => "stable-session", getLeafId: () => leaf };
  await assert.rejects(() => compactWithWarmPrefix(f.pi, f.event, f.ctx, f.plan, async () => {
    leaf = "leaf-b";
    return response([{ type: "text", text: "x" }]);
  }), /source changed/);
});

test("warm-prefix compaction honors an already-aborted event", async () => {
  const f = fixture();
  const controller = new AbortController(); controller.abort();
  (f.event as any).signal = controller.signal;
  let called = false;
  await assert.rejects(() => compactWithWarmPrefix(f.pi, f.event, f.ctx, f.plan, async () => { called = true; return response([{ type: "text", text: "x" }]); }), /aborted before dispatch/);
  assert.equal(called, false);
});

test("warm-prefix compaction honors Prime requestModel and resolved auth", async () => {
  const f = fixture();
  const requestModel = { ...model, id: "request-adjusted", baseUrl: "https://routed.invalid" } as Model<any>;
  (f.ctx as any).modelRegistry.getApiKeyAndHeaders = async () => ({
    ok: true, apiKey: "resolved-key", headers: { "x-route": "resolved" }, requestModel,
  });
  let seenModel: Model<any> | undefined;
  let seenOptions: SimpleStreamOptions | undefined;
  await compactWithWarmPrefix(f.pi, f.event, f.ctx, f.plan, async (selected, _context, options) => {
    seenModel = selected; seenOptions = options;
    return response([{ type: "text", text: "summary" }]);
  });
  assert.equal(seenModel?.id, "request-adjusted");
  assert.equal(seenOptions?.apiKey, "resolved-key");
  assert.deepEqual(seenOptions?.headers, { "x-route": "resolved" });
});
