import assert from "node:assert/strict";
import test from "node:test";
import { classifyTokenPressure, measureSessionTokens } from "../src/context-pressure.js";
import { ProviderCacheSeries } from "../src/provider-cache-series.js";
import { balancedCuts, planStandaloneCompaction, runCompactionPlanning } from "../src/standalone-compaction-planner.js";

test("token breakdown is deterministic and exposes replay work per request", () => {
  const messages = [
    { id: "u1", role: "user", content: "one" },
    { id: "a1", role: "assistant", content: "two", usage: { input: 7, cacheRead: 3 } },
    { id: "u2", role: "user", content: "three" },
    { id: "a2", role: "assistant", content: "four", usage: { input: 11 } },
  ];
  const adapter = { name: "fixture", estimateMessage: () => 10 };
  const result = measureSessionTokens(messages, adapter);
  assert.deepEqual(result.messages.map(x => x.replayRequestTokens), [undefined, 10, undefined, 30]);
  assert.equal(result.surfaceTokens, 40); assert.equal(result.replayTokens, 40);
  assert.equal(result.reportedRequestTokens, 18); assert.equal(result.requestCount, 2);
  assert.deepEqual(measureSessionTokens(messages, adapter), result);
  assert.equal(classifyTokenPressure(80, 100, .8), "compact");
  assert.equal(classifyTokenPressure(101, 100), "overflow");
});

test("provider cache series preserves missing reports and never mixes prefix eligibility", () => {
  const series = new ProviderCacheSeries();
  series.add({ request: 1, inputTokens: 100 });
  const point = series.add({ request: 2, inputTokens: 25, cacheReadTokens: 75, cacheWriteTokens: 10 });
  series.add({ request: 3, inputTokens: 20, cacheReadTokens: 80 });
  assert.equal(point.efficiency, .75);
  assert.deepEqual(series.points().map(x => x.cacheReadTokens), [undefined, 75, 80]);
  const aggregate = series.aggregate();
  assert.equal(aggregate.reportedReadRequests, 2); assert.equal(aggregate.reportedWriteRequests, 1);
  assert.equal(aggregate.readP50, 75); assert.equal(aggregate.readP90, 80);
  assert.equal(aggregate.writeP50, 10); assert.equal(aggregate.efficiencyP90, .8);
  assert.equal(aggregate.efficiency, 155 / 300);
  assert.equal("prefixRatio" in aggregate, false);
});

const node = (id: string, role: string, tokens: number, content?: unknown, extra: Record<string, unknown> = {}) =>
  ({ message: { id, role, content, ...extra }, tokens });

test("compaction keeps a stable recent tail and cannot split tool call/result pairs", () => {
  const nodes = [
    node("sys", "system", 5), node("old", "user", 50),
    node("call", "assistant", 20, [{ type: "toolCall", id: "c1", name: "read" }]),
    node("result", "toolResult", 60, [], { toolCallId: "c1" }),
    node("recent-u", "user", 30), node("recent-a", "assistant", 30),
  ];
  assert.deepEqual(balancedCuts(nodes), [0, 1, 2, 4, 5, 6]);
  const p = planStandaloneCompaction(nodes, { mode: "active", contextWindow: 100, thresholdRatio: .8, retainTokens: 50 }, "pressure");
  assert.equal(p.action, "compact"); assert.deepEqual([p.range?.start, p.range?.end], [1, 3]);
  assert.equal(p.retainedTokens, 60); assert.deepEqual(p.range?.provenance.sourceIds, ["old", "call", "result"]);
  assert.match(p.range!.marker, /source=old\.\.result/);
  assert.equal(nodes[2]!.message.id, "call"); // immutable input
});

test("overflow retries, modes, malformed pairs, and planner errors fail open", () => {
  const nodes = [node("old", "user", 100), node("new", "user", 10)];
  const exhausted = planStandaloneCompaction(nodes, { contextWindow: 100, retainTokens: 10, maxOverflowRetries: 1 }, "context-overflow", 1);
  assert.equal(exhausted.reason, "overflow-retries-exhausted");
  let calls = 0;
  assert.deepEqual(runCompactionPlanning("off", () => { calls++; return exhausted; }), { mode: "off" }); assert.equal(calls, 0);
  const shadow = runCompactionPlanning("shadow", () => planStandaloneCompaction(nodes, { contextWindow: 100, retainTokens: 10 }, "pressure"));
  assert.equal(shadow.observed?.action, "compact"); assert.equal(shadow.applied, undefined);
  const active = runCompactionPlanning("active", () => planStandaloneCompaction(nodes, { contextWindow: 100, retainTokens: 10 }, "pressure"));
  assert.equal(active.applied?.action, "compact");
  const broken = runCompactionPlanning("active", () => planStandaloneCompaction([
    node("orphan", "toolResult", 10, [], { toolCallId: "missing" })
  ], { contextWindow: 1, retainTokens: 0 }, "pressure"));
  assert.match(broken.error!, /unpaired/); assert.equal(broken.applied, undefined);
});
