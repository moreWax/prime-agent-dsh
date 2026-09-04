import test from "node:test";
import assert from "node:assert/strict";
import { ContextService } from "../src/service.js";
import { PROTOCOL, type MethodResult, type Response } from "../src/protocol.js";

const req = (id: number, method: string, params?: unknown) => ({ version: PROTOCOL, id, method, params });
function result(response: Response): MethodResult {
  assert.equal(response.ok, true);
  return response.result;
}
function errorCode(response: Response): string {
  assert.equal(response.ok, false);
  return response.ok ? "" : response.error.code;
}
function textOf(message: unknown): string {
  assert(message && typeof message === "object" && "content" in message);
  const content = message.content;
  assert(Array.isArray(content) && content[0] && typeof content[0] === "object" && "text" in content[0]);
  assert.equal(typeof content[0].text, "string");
  return content[0].text;
}

test("requires initialization and rejects protocol mismatch", () => {
  const service = new ContextService();
  assert.equal(errorCode(service.handle(req(1, "status"))), "NOT_INITIALIZED");
  assert.equal(errorCode(service.handle({ ...req(2, "initialize"), version: "x" })), "UNSUPPORTED_VERSION");
});

test("sync uses DSH Session and project derives canonical messages", () => {
  const service = new ContextService();
  const initialized = result(service.handle(req(1, "initialize")));
  assert("capabilities" in initialized);
  assert.equal(initialized.capabilities.agentLoop, false);

  const synced = result(service.handle(req(2, "session/sync", {
    sessionId: "s1",
    messages: [{ role: "user", content: "hello" }, { role: "assistant", content: "hi", provider: "p", model: "m" }],
  })));
  assert("revision" in synced);
  assert.equal(synced.revision, 1);

  const projected = result(service.handle(req(3, "project", { sessionId: "s1" })));
  assert("total" in projected);
  assert.equal(projected.total, 2);
  assert.deepEqual(projected.messages.map(textOf), ["hello", "hi"]);
  const assistant = projected.messages[1];
  assert(assistant && typeof assistant === "object" && "source" in assistant);
  assert(assistant.source && typeof assistant.source === "object" && "provider" in assistant.source);
  assert.equal(assistant.source.provider, "p");
});

test("sync is atomic and revision guarded", () => {
  const service = new ContextService();
  service.handle(req(1, "initialize"));
  service.handle(req(2, "session/sync", { sessionId: "s", messages: [] }));
  assert.equal(errorCode(service.handle(req(3, "session/sync", { sessionId: "s", expectedRevision: 0, messages: [] }))), "REVISION_CONFLICT");
  const status = result(service.handle(req(4, "status")));
  assert("sessions" in status);
  assert.equal(status.sessions[0]?.revision, 1);
});

test("pagination, unknown session, shutdown", async () => {
  let stopped = false;
  const service = new ContextService(() => { stopped = true; });
  service.handle(req(1, "initialize"));
  service.handle(req(2, "session/sync", { sessionId: "s", messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }] }));
  const page = result(service.handle(req(3, "project", { sessionId: "s", from: 1, limit: 1 })));
  assert("messages" in page);
  assert.equal(textOf(page.messages[0]), "b");
  assert.equal(errorCode(service.handle(req(4, "project", { sessionId: "none" }))), "SESSION_NOT_FOUND");
  const shutdown = result(service.handle(req(5, "shutdown")));
  assert("accepted" in shutdown);
  assert.equal(shutdown.accepted, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, true);
  assert.equal(errorCode(service.handle(req(6, "project", { sessionId: "s" }))), "SHUTTING_DOWN");
});

test("validators reject malformed nested values without coercion", () => {
  const service = new ContextService();
  service.handle(req(1, "initialize"));
  assert.equal(errorCode(service.handle(req(2, "session/sync", { sessionId: "s", messages: [{ role: "user", content: "ok", source: 3 }] }))), "INVALID_PARAMS");
  assert.equal(errorCode(service.handle(req(3, "project", { sessionId: "s", from: 1.5 }))), "INVALID_PARAMS");
});
