import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { DshContextShadow, projectionPromotionMode } from "../src/dsh-context-shadow.js";
import { ContextService } from "../src/dsh-context-service.js";
import type { Response } from "../src/context-protocol.js";

const model = { provider: "test", id: "m", api: "openai-completions" } as Model<Api>;
const context = (): Context => ({
  systemPrompt: "keep exact",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
  tools: [{ name: "tool", description: "exact", parameters: { type: "object", properties: {} } }],
});
const key = { sessionId: "s", branchId: "b" };

void test("projection promotion is shadow by default and returns untouched context", async () => {
  assert.equal(projectionPromotionMode({}), "shadow");
  const original = context();
  const outcome = await new DshContextShadow(undefined, undefined, { mode: "shadow" }).project(original, model, key);
  assert.equal(outcome.selected, false);
  assert.equal(outcome.reason, "shadow-mode");
  assert.equal(outcome.context, original);
});

void test("active promotion selects only a full-context round-trip parity projection", async () => {
  const original = context();
  const shadow = new DshContextShadow(undefined, undefined, { mode: "active" });
  const outcome = await shadow.project(original, model, key);
  assert.equal(outcome.selected, true);
  assert.equal(outcome.reason, "full-round-trip-parity");
  assert.notEqual(outcome.context, original);
  assert.deepEqual(outcome.context, original);
  assert.equal(shadow.stats.promotions, 1);
});

void test("canary requires explicit admission in addition to parity", async () => {
  const rejectedInput = context();
  const rejected = await new DshContextShadow(undefined, undefined, { mode: "canary" }).project(rejectedInput, model, key);
  assert.equal(rejected.selected, false);
  assert.equal(rejected.reason, "canary-not-selected");
  assert.equal(rejected.context, rejectedInput);

  const admitted = await new DshContextShadow(undefined, undefined, { mode: "canary", selectCanary: () => true }).project(context(), model, key);
  assert.equal(admitted.selected, true);
  assert.equal(admitted.mode, "canary");
});

void test("malformed projection fails open with the exact original context", async () => {
  class MalformedService extends ContextService {
    override handle(raw: unknown): Response {
      const response = super.handle(raw);
      if (response.ok && typeof raw === "object" && raw !== null && "method" in raw && raw.method === "project") {
        return { ...response, result: { ...response.result, total: 999 } } as Response;
      }
      return response;
    }
  }
  const original = context();
  const outcome = await new DshContextShadow(new MalformedService(), undefined, { mode: "active" }).project(original, model, key);
  assert.equal(outcome.selected, false);
  assert.equal(outcome.reason, "invalid-projection");
  assert.equal(outcome.context, original);
});

void test("invalid feature mode fails closed during configuration", () => {
  assert.throws(() => projectionPromotionMode({ PRIME_DSH_PROJECTION_MODE: "on" }), /shadow, canary, or active/);
});
