import assert from "node:assert/strict";
import test from "node:test";
import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { DSH_PRUNE_MARKER, DurableCompactionController, planCompaction, pruneToolResults, resolvePrunePolicy } from "../src/compaction.js";

function tool(text: string, rich = false) {
  return { role: "toolResult" as const, toolCallId: "call-1", toolName: "read", content: [
    { type: "text" as const, text }, ...(rich ? [{ type: "image" as const, data: "AA==", mimeType: "image/png" }] : [])
  ], isError: false, timestamp: 1 };
}
function event(messages: any[]): SessionBeforeCompactEvent {
  return { type: "session_before_compact", preparation: { firstKeptEntryId: "keep", messagesToSummarize: messages,
    turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 1000, fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: { enabled: true, reserveTokens: 10, keepRecentTokens: 20 } }, branchEntries: [], reason: "threshold",
    willRetry: false, signal: new AbortController().signal } as unknown as SessionBeforeCompactEvent;
}

test("prune budgets must fit the stable DSH marker", () => {
  assert.throws(() => resolvePrunePolicy({ thresholdChars: 10, headChars: 2, tailChars: 2 }), /marker/);
});

test("pruner is deterministic, unicode safe, and leaves input untouched", () => {
  const original = "😀".repeat(5000);
  const input = [tool(original, true)];
  const a = pruneToolResults(input, { thresholdChars: 200, headChars: 50, tailChars: 50 });
  const b = pruneToolResults(input, { thresholdChars: 200, headChars: 50, tailChars: 50 });
  assert.deepEqual(a, b);
  assert.equal(input[0]?.content[0]?.type === "text" && input[0].content[0].text, original);
  const blocks = (a.messages[0] as any).content;
  assert.equal(blocks[0].text, "😀".repeat(50) + DSH_PRUNE_MARKER + "😀".repeat(50));
  assert.equal(blocks[1].type, "image");
  assert.equal(a.facts[0]?.charsBefore, 5000);
});

test("planner preserves Prime durable cut and replaces only summarized tool results", () => {
  const e = event([tool("x".repeat(9000))]);
  const plan = planCompaction(e);
  assert.equal(plan.firstKeptEntryId, "keep");
  assert.equal(plan.preparation.firstKeptEntryId, e.preparation.firstKeptEntryId);
  assert.equal(plan.pruned.length, 1);
  assert.equal((e.preparation.messagesToSummarize[0] as any).content[0].text.length, 9000);
  assert.notEqual(plan.preparation.messagesToSummarize[0], e.preparation.messagesToSummarize[0]);
});

class FakePi {
  handlers: Record<string, (...args: unknown[]) => unknown> = {};
  on(name: string, handler: (...args: unknown[]) => unknown) { this.handlers[name] = handler; }
}
const ctx = {} as any;

test("off registers no seam; shadow plans but cannot mutate", async () => {
  const off = new FakePi(); let calls = 0;
  new DurableCompactionController({ mode: "off", pruning: resolvePrunePolicy() }, async () => { calls++; return {} as any; }).register(off as any);
  assert.equal(off.handlers.session_before_compact, undefined);
  const shadow = new FakePi();
  const controller = new DurableCompactionController({ mode: "shadow", pruning: resolvePrunePolicy() }, async () => { calls++; return {} as any; });
  controller.register(shadow as any);
  assert.equal(await shadow.handlers.session_before_compact!(event([tool("x".repeat(9000))]), ctx), undefined);
  assert.equal(calls, 0); assert.equal(controller.diagnostics().plans, 1);
});

test("active returns a CompactionResult only through session_before_compact and fails open", async () => {
  const pi = new FakePi(); const expected = { summary: "ok", firstKeptEntryId: "keep", tokensBefore: 1000 } as any;
  const controller = new DurableCompactionController({ mode: "active", pruning: resolvePrunePolicy() }, async (_e, _c, plan) => {
    assert.equal(plan.pruned.length, 1); return expected;
  });
  controller.register(pi as any);
  assert.deepEqual(await pi.handlers.session_before_compact!(event([tool("x".repeat(9000))]), ctx), { compaction: expected });
  assert.equal(controller.diagnostics().active, 1);
  const broken = new FakePi();
  new DurableCompactionController({ mode: "active", pruning: resolvePrunePolicy() }, async () => { throw new Error("down"); }).register(broken as any);
  assert.equal(await broken.handlers.session_before_compact!(event([]), ctx), undefined);
});
