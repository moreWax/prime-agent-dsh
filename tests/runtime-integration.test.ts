import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension, { DSH_SOURCE_PATH, DSH_SOURCE_URL, DSH_VERSION, PRIME_COMPATIBILITY } from "../extensions/index.js";

type Handler = (event: any, ctx: ExtensionContext) => unknown;
type Command = { handler: (args: string, ctx: ExtensionContext) => Promise<void> };

function daemonFixture() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, Command>();
  const pi = {
    on(event: string, handler: Handler) {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
      return () => undefined;
    },
    registerCommand(name: string, command: Command) { commands.set(name, command); },
    registerFlag() {},
    getFlag() { return undefined; },
  } as unknown as ExtensionAPI;
  const statuses: Array<[string, string | undefined]> = [];
  const widgets: Array<[string, string[] | undefined, unknown]> = [];
  const notices: Array<[string, string | undefined]> = [];
  const context = {
    mode: "rpc",
    cwd: "/daemon/workspace",
    hasUI: true,
    model: { provider: "deepseek", id: "deepseek-chat" },
    scopedModels: [],
    ui: {
      setStatus(key: string, value: string | undefined) { statuses.push([key, value]); },
      setWidget(key: string, value: string[] | undefined, options?: unknown) { widgets.push([key, value, options]); },
      notify(message: string, level?: string) { notices.push([message, level]); },
    },
    sessionManager: {
      getSessionId: () => "daemon-session",
      getSessionFile: () => undefined,
      getSessionDir: () => undefined,
      getLeafId: () => "root",
      getBranch: () => [],
    },
    isIdle: () => true,
    isProjectTrusted: () => true,
    hasPendingMessages: () => false,
    getCommands: () => [{ name: "dsh-session", sourceInfo: { path: "/installed/prime-agent-dsh/extensions/index.ts", source: "package", scope: "user", origin: "package" } }],
  } as unknown as ExtensionContext;
  return { pi, handlers, commands, statuses, widgets, notices, context };
}

async function emit(fixture: ReturnType<typeof daemonFixture>, event: string, value: any = {}) {
  for (const handler of fixture.handlers.get(event) ?? []) await handler(value, fixture.context);
}

test("process-global install guard rejects a second DSH copy for one ExtensionAPI identity", () => {
  const fixture = daemonFixture();
  extension(fixture.pi);
  const initial = [...fixture.handlers.values()].reduce((sum, entries) => sum + entries.length, 0);
  extension(fixture.pi);
  assert.equal([...fixture.handlers.values()].reduce((sum, entries) => sum + entries.length, 0), initial);
  assert.equal(fixture.commands.size, 3);

  const anotherSessionRuntime = daemonFixture();
  extension(anotherSessionRuntime.pi);
  assert.equal(anotherSessionRuntime.commands.size, 3, "a distinct ExtensionAPI must remain installable in this process");
});

test("daemon-shaped native UI receives finalized cache usage and lifecycle re-emission", async () => {
  const fixture = daemonFixture();
  extension(fixture.pi);
  await emit(fixture, "session_start", { reason: "startup" });
  await emit(fixture, "message_end", {
    message: {
      role: "assistant", content: [], api: "openai-completions", provider: "deepseek", model: "deepseek-chat",
      usage: { input: 90, output: 5, cacheRead: 810, cacheWrite: 0, totalTokens: 905, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(),
    },
  });
  assert.deepEqual(fixture.statuses.at(-1), ["prime-agent-dsh-cache", "DSH cache · turn 90.0% · session 90.0%"]);
  assert.deepEqual(fixture.widgets.at(-1), ["prime-agent-dsh-cache-widget", ["DSH cache · turn 90.0% · session 90.0%"], { placement: "aboveEditor" }]);

  const beforeLifecycle = fixture.statuses.length;
  await emit(fixture, "model_select", { source: "restore", model: fixture.context.model, previousModel: undefined });
  await emit(fixture, "session_info_changed", { name: "attached-through-daemon" });
  assert.equal(fixture.statuses.length, beforeLifecycle + 2);
  assert.deepEqual(fixture.statuses.at(-1), ["prime-agent-dsh-cache", "DSH cache · turn 90.0% · session 90.0%"], "lifecycle emission must retain finalized usage");
  const beforeUser = fixture.statuses.length;
  await emit(fixture, "message_end", { message: { role: "user", content: "hello", timestamp: Date.now() } });
  assert.equal(fixture.statuses.length, beforeUser, "non-assistant messages do not change cache status");
  await emit(fixture, "session_shutdown", {});
  assert.deepEqual(fixture.statuses.at(-1), ["prime-agent-dsh-cache", undefined]);
  assert.deepEqual(fixture.widgets.at(-1), ["prime-agent-dsh-cache-widget", undefined, undefined]);
  assert(fixture.statuses.every(([key]) => key === "prime-agent-dsh-cache"), "only Prime native setStatus is used");
});

test("session status and doctor expose runtime provenance and restart guidance", async () => {
  const fixture = daemonFixture();
  extension(fixture.pi);
  await emit(fixture, "session_start", { reason: "startup" });
  await fixture.commands.get("dsh-session")?.handler("status", fixture.context);
  const status = fixture.notices.at(-1)?.[0] ?? "";
  assert.match(status, new RegExp(`pluginVersion=${DSH_VERSION}`));
  assert(status.includes(`compatibility=${PRIME_COMPATIBILITY}`));
  assert.match(status, /lastSyncAge=pending/);
  assert.match(status, /lastError=none/);
  assert.match(status, /restart=restart Prime after install\/update/);
  assert(status.includes("sourceIdentity=package:user:package"));
  assert(status.includes("sourcePath=/installed/prime-agent-dsh/extensions/index.ts"));
  assert(DSH_SOURCE_URL.startsWith("file:"));
  assert(DSH_SOURCE_PATH.endsWith("extensions/index.ts"));

  await fixture.commands.get("dsh-session")?.handler("doctor", fixture.context);
  const doctor = fixture.notices.at(-1)?.[0] ?? "";
  assert.match(doctor, /pluginVersion=0\.2\.0/);
  assert.match(doctor, /restart Prime after install\/update/);
});
