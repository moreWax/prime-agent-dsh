import assert from "node:assert/strict";
import test from "node:test";
import { ProviderCacheSeries } from "../src/provider-cache-series.js";

test("provider cache series preserves missing reports and stays interpretation-free", () => {
  const series = new ProviderCacheSeries();
  series.add({ request: 1, inputTokens: 100 });
  const point = series.add({ request: 2, inputTokens: 25, cacheReadTokens: 75, cacheWriteTokens: 10 });
  series.add({ request: 3, inputTokens: 20, cacheReadTokens: 80 });
  assert.equal(point.efficiency, .75);
  assert.deepEqual(series.points().map((value) => value.cacheReadTokens), [undefined, 75, 80]);
  const aggregate = series.aggregate();
  assert.equal(aggregate.reportedReadRequests, 2);
  assert.equal(aggregate.reportedWriteRequests, 1);
  assert.equal(aggregate.readP50, 75);
  assert.equal(aggregate.readP90, 80);
  assert.equal(aggregate.writeP50, 10);
  assert.equal(aggregate.efficiencyP90, .8);
  assert.equal(aggregate.efficiency, 155 / 300);
  assert.equal("prefixRatio" in aggregate, false);
});
