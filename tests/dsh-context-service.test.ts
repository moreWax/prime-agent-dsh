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
