import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.js";

type Handler = (event: { messages?: readonly unknown[] }, ctx: ExtensionContext) => unknown;

function hostFixture() {
  const handlers = new Map<string, Handler[]>();
  const commands: string[] = [];
  const forbidden: string[] = [];
  const base = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name: string) { commands.push(name); },
    registerFlag() {},
    getFlag() { return undefined; },
  };
  const pi = new Proxy(base as unknown as ExtensionAPI, {
    get(target, key, receiver) {
      if (key === "registerProvider" || key === "unregisterProvider" || key === "registerTool") {
        forbidden.push(String(key));
        throw new Error(`Prime ownership violation: ${String(key)}`);
      }
      return Reflect.get(target, key, receiver);
    },
  });
  return { pi, handlers, commands, forbidden };
}

function context(): ExtensionContext {
  const value = {
    cwd: "/workspace",
    hasUI: false,
    model: undefined,
    ui: { notify() {}, setStatus() {} },
    sessionManager: {
      getSessionId: () => "root",
      getSessionFile: () => undefined,
      getLeafId: () => "leaf",
      getBranch: () => [],
    },
  };
  return new Proxy({} as ExtensionContext, { get: (_target, key) => Reflect.get(value, key) });
}

test("production entrypoint cannot register providers or model-facing tools", async () => {
  const fixture = hostFixture();
  extension(fixture.pi);
  const ctx = context();
  for (const handler of fixture.handlers.get("session_start") ?? []) await handler({}, ctx);
  assert.deepEqual(fixture.forbidden, []);
  assert(fixture.commands.includes("dsh-session"));
  assert(fixture.commands.includes("dsh-context-status"));
  assert.equal(fixture.handlers.get("before_agent_start")?.length, 1);
  assert.equal(fixture.handlers.get("context")?.length, 3);
});

test("production context observers preserve Prime messages by identity and value", async () => {
  const fixture = hostFixture();
  extension(fixture.pi);
  const ctx = context();
  const messages = Object.freeze([
    Object.freeze({ role: "user", content: "Prime owns this" }),
  ]);
  const before = JSON.stringify(messages);
  for (const handler of fixture.handlers.get("context") ?? []) {
    const result = await handler({ messages }, ctx);
    assert.equal(result, undefined, "context sidecar must not return a replacement context");
  }
  assert.equal(JSON.stringify(messages), before);
  assert.equal(messages[0]?.content, "Prime owns this");
});

test("production entrypoint has no provider-wrapper dependency", async () => {
  const source = await readFile(new URL("../extensions/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /registerProvider\s*\(/);
  assert.doesNotMatch(source, /registerTool\s*\(/);
  assert.doesNotMatch(source, /TransparentProviderController|streamSimple/);
});


test("release manifest contains only Prime-native sidecar sources and minimal DSH dependencies", async () => {
  const root = resolve(new URL("..", import.meta.url).pathname);
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    files: string[];
    dependencies: Record<string, string>;
  };
  const dshDependencies = Object.keys(manifest.dependencies)
    .filter((name) => name.startsWith("@deepseek-ai/"))
    .sort();
  assert.deepEqual(dshDependencies, [
    "@deepseek-ai/cordis",
    "@deepseek-ai/dsh-attachment",
    "@deepseek-ai/dsh-attachment-local",
    "@deepseek-ai/dsh-llm",
    "@deepseek-ai/dsh-session",
  ]);
  assert(!manifest.files.some((file) => /(?:dsh-provider|model-wrapper|agent-pool|branch-checkpoint|acp-client|transparent-routing)/i.test(file)));

  const productionSources = manifest.files.filter((file) => /^(?:src|extensions)\/.+\.ts$/.test(file));
  for (const file of productionSources) {
    const source = await readFile(resolve(root, file), "utf8");
    assert.doesNotMatch(source, /\.registerProvider\s*\(/, `${file} must not register a provider`);
    assert.doesNotMatch(source, /\.registerTool\s*\(/, `${file} must not register a model-facing tool`);
    assert.doesNotMatch(source, /new\s+AgentLoop|TurnCheckpoint|TransparentProviderController/i, `${file} contains a legacy loop/checkpoint surface`);
  }
});
