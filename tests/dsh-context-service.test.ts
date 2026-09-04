import assert from "node:assert/strict";
import test from "node:test";
import { ContextService } from "../src/dsh-context-service.js";
import { PROTOCOL } from "../src/context-protocol.js";

test("DSH shadow service projects a simple Prime transcript without an agent loop", () => {
  const service = new ContextService();
  const call = (id: number, method: string, params?: unknown) => service.handle({ version: PROTOCOL, id, method, params }) as any;
  assert.equal(call(1, "initialize").result.capabilities.agentLoop, false);
  const sync = call(2, "session/sync", { sessionId: "prime:s:leaf", expectedRevision: 0,
    messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "world", provider: "p", model: "m" }] });
  assert.equal(sync.result.messageCount, 2);
  const projected = call(3, "project", { sessionId: "prime:s:leaf" });
  assert.deepEqual(projected.result.messages.map((message: any) => message.role), ["user", "assistant"]);
});

test("canonical sync is no-op when identical and appends only a suffix", async () => {
  const { primeToDsh } = await import("../src/context-converter.js");
  const service = new ContextService(); const call = (id: number, method: string, params?: unknown) => service.handle({ version: PROTOCOL, id, method, params }) as any;
  call(1, "initialize");
  const first = [primeToDsh({ id: "u1", message: { role: "user", content: [{ type: "text", text: "a" }] } } as any)];
  const a = call(2, "session/sync-canonical", { sessionId: "s", messages: first, expectedRevision: 0 });
  const b = call(3, "session/sync-canonical", { sessionId: "s", messages: first, expectedRevision: 1 });
  const second = [...first, primeToDsh({ id: "a1", message: { role: "assistant", content: [{ type: "text", text: "b" }], provider: "p", model: "m" } } as any)];
  const c = call(4, "session/sync-canonical", { sessionId: "s", messages: second, expectedRevision: 1 });
  assert.equal(a.result.mode, "rebuild"); assert.equal(b.result.mode, "noop"); assert.equal(b.result.revision, 1);
  assert.equal(c.result.mode, "append"); assert.equal(c.result.commonPrefixMessages, 1); assert.equal(c.result.revision, 2);
});
