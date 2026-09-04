import assert from "node:assert/strict";
import test from "node:test";
import { DSH_CAPABILITIES, dshCapabilityRegistry, formatDshCapabilities, type DshCapabilityStatus } from "../src/dsh-capabilities.js";

const expected = ["images", "questions", "mcp", "goals", "plan", "compaction", "subagents", "workflows", "jobs", "terminals", "web", "cache"];

test("registry covers the requested base capability surface exactly", () => {
  assert.deepEqual(DSH_CAPABILITIES.map((item) => item.id), expected);
  assert.equal(new Set(DSH_CAPABILITIES.map((item) => item.id)).size, expected.length);
  assert.deepEqual(dshCapabilityRegistry(), DSH_CAPABILITIES);
});

test("every claim has typed status and concrete evidence", () => {
  const statuses = new Set<DshCapabilityStatus>(["verified", "loaded", "degraded", "unavailable"]);
  for (const item of DSH_CAPABILITIES) {
    assert.ok(statuses.has(item.status));
    assert.ok(item.summary.length > 10);
    assert.ok(item.evidence.length > 0);
    for (const evidence of item.evidence) {
      assert.ok(evidence.source);
      assert.ok(evidence.detail);
    }
  }
});

test("registry avoids known overclaims", () => {
  const byId = Object.fromEntries(DSH_CAPABILITIES.map((item) => [item.id, item]));
  assert.equal(byId.images?.status, "verified");
  assert.equal(byId.questions?.status, "verified");
  assert.equal(byId.plan?.status, "verified");
  assert.equal(byId.subagents?.status, "verified");
  assert.equal(byId.workflows?.status, "verified");
  assert.equal(byId.jobs?.status, "verified");
  assert.equal(byId.mcp?.status, "unavailable");
  assert.equal(byId.terminals?.status, "unavailable");
  assert.equal(byId.web?.status, "degraded");
  assert.equal(byId.cache?.status, "verified");
  assert.match(byId.cache?.summary ?? "", /provider-reported cache reads/);
});

test("human report includes status totals, each capability, and probe caveat", () => {
  const output = formatDshCapabilities();
  assert.match(output, /verified=9, loaded=0, degraded=1, unavailable=2/);
  for (const item of DSH_CAPABILITIES) assert.match(output, new RegExp(`^${item.label}: ${item.status}`, "m"));
  assert.match(output, /does not probe credentials or external services/);
});


test("optional operator composition changes MCP and terminal claims without claiming verification", () => {
  const configured = dshCapabilityRegistry({ mcpServers: [{}], persistentTerminal: true });
  const byId = Object.fromEntries(configured.map((item) => [item.id, item]));
  assert.equal(byId.mcp?.status, "loaded");
  assert.equal(byId.terminals?.status, "loaded");
  assert.match(byId.mcp?.summary ?? "", /not probed/);
  assert.match(byId.terminals?.summary ?? "", /not probed/);
});
