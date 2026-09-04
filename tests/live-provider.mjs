import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { registerProvider, createInstanceRuntime } from "../src/dsh-provider.ts";
import { preparePrimeRoute } from "../src/model-route.ts";
import { createPrivateRootConfig } from "../src/dsh-provider-security.ts";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), "prime-agent-dsh-live-"));
const home = join(root, "dsh-home");
const workspace = join(root, "workspace");
mkdirSync(home); mkdirSync(workspace);
const marker = join(workspace, "native-marker.txt");
const outsideMarker = join(process.env.HOME ?? "/", `.prime-dsh-live-must-not-write-${process.pid}`);
process.env.DSH_HOME = home;
process.env.DSH_TELEMETRY_DISABLED = "1";
process.env.MOCK_MARKER = marker;
process.env.MOCK_OUTSIDE_MARKER = outsideMarker;

const server = spawn(process.execPath, [join(here, "tests/fixtures/mock-openai-server.mjs"), "0"], {
  env: process.env, stdio: ["ignore", "pipe", "inherit"],
});
const address = await new Promise((resolve, reject) => {
  let line = "";
  server.stdout.setEncoding("utf8");
  server.stdout.on("data", (data) => { line += data; if (line.includes("\n")) resolve(JSON.parse(line.split("\n")[0])); });
  server.once("error", reject);
  server.once("exit", (code) => reject(new Error(`mock server exited early: ${code}`)));
});
const baseUrl = `http://127.0.0.1:${address.port}/v1`;
let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`PASS ${label}`); }
  catch (error) { failures++; console.error(`FAIL ${label} — ${error.message}`); }
}
async function stats() { return fetch(baseUrl.replace(/\/v1$/, "/stats")).then((response) => response.json()); }

let route;
try {
  const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
  check("embedded DSH remains pinned to alpha.5", () => {
    assert.equal(pkg.dependencies["@deepseek-ai/dsh-app-boot"], "0.1.2-alpha.5");
    const dshOverrides = Object.entries(pkg.overrides).filter(([name]) => name.startsWith("@deepseek-ai/dsh"));
    assert.ok(dshOverrides.length > 100);
    assert.ok(dshOverrides.every(([, version]) => version === "0.1.2-alpha.5"));
  });

  const nativeModel = {
    id: "mock-1", name: "Deterministic Mock", provider: "mock-local",
    api: "openai-completions", baseUrl, reasoning: false, input: ["text"],
    contextWindow: 65536, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  route = await preparePrimeRoute({ model: nativeModel, auth: { apiKey: "not-a-vendor-key" } }, home);
  const runtime = createInstanceRuntime();
  runtime.cwd = workspace;
  runtime.sessionKey = `accept-${Date.now()}`;
  runtime.resolveRoute = async () => route;
  let registration;
  registerProvider({ registerProvider(name, config) { registration = { name, config }; } }, {
    dshBin: "unused", timeoutMs: 30_000, mode: "pool", poolMax: 2,
    poolIdleTtlMs: 60_000, fullAccess: false,
  }, runtime);

  check("actual dsh provider registers", () => assert.equal(registration?.name, "dsh"));
  check("actual provider exposes streamSimple", () => assert.equal(typeof registration?.config.streamSimple, "function"));
  check("catalog preserves stable harness identity", () => assert.equal(registration?.config.models[0].id, "dsh-harness"));
  check("Prime route uses loopback capability proxy", () => {
    assert.match(route.proxy.baseUrl, /^http:\/\/127\.0\.0\.1:/);
    assert.ok(!readFileSync(route.modelPatch, "utf8").includes("not-a-vendor-key"));
  });

  const model = { ...registration.config.models[0], provider: "dsh", api: "dsh-exec" };
  async function turn(text, signal) {
    const stream = registration.config.streamSimple(model, {
      messages: [{ role: "user", content: text, timestamp: Date.now() }], tools: [],
    }, { sessionId: runtime.sessionKey, signal });
    const events = [];
    for await (const event of stream) events.push(event.type);
    const result = await stream.result();
    return { result, events, text: (result?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("") };
  }

  const seed = await turn("Remember ZEBRA_XYZZY. Reply ok.");
  check("embedded alpha.5 DSH boots and streams", () => {
    assert.equal(seed.result.stopReason, "stop");
    assert.ok(seed.events.indexOf("text_delta") >= 0 && seed.events.indexOf("text_delta") < seed.events.indexOf("done"));
  });
  const recall = await turn("RECALL_TOKEN");
  check("pool preserves same-session continuity", () => assert.equal(recall.text, "ZEBRA_XYZZY"));

  const beforeTool = await stats();
  const tool = await turn("NATIVE_TOOL");
  const afterTool = await stats();
  check("DSH executes its native bash tool", () => assert.equal(readFileSync(marker, "utf8"), "native-dsh-tool-result"));
  check("native tool result returns through DSH", () => assert.equal(tool.text, "native-dsh-tool-ok"));
  check("Prime receives no executable tool calls", () => assert.ok(!tool.events.some((type) => type.startsWith("toolcall_"))));
  check("one native tool cycle makes exactly two model requests", () => assert.equal(afterTool.requests - beforeTool.requests, 2));
  check("mock observes exactly one tool request", () => assert.equal(afterTool.toolRequests - beforeTool.toolRequests, 1));

  const escape = await turn("ESCAPE_TOOL");
  check("workspace sandbox blocks native tool writes outside cwd", () => {
    assert.equal(escape.result.stopReason, "stop");
    assert.equal(existsSync(outsideMarker), false);
  });

  const abort = new AbortController();
  setTimeout(() => abort.abort(), 150);
  const cancelled = await turn("ABORT_SLOW", abort.signal);
  check("abort terminates active DSH turn", () => assert.equal(cancelled.result.stopReason, "aborted"));
  const alive = await turn("RECALL_TOKEN");
  check("abort preserves pooled session", () => assert.equal(alive.text, "ZEBRA_XYZZY"));

  const privateRoot = createPrivateRootConfig();
  try { check("loader root config is owner-only", () => assert.equal(statSync(privateRoot.path).mode & 0o777, 0o600)); }
  finally { privateRoot.cleanup(); }
} finally {
  await route?.proxy.close();
  server.kill("SIGTERM");
  rmSync(outsideMarker, { force: true });
  rmSync(root, { recursive: true, force: true });
}
if (failures) { console.error(`\n${failures} live acceptance assertion(s) failed`); process.exit(1); }
console.log("\nall live provider acceptance assertions passed");
process.exit(0);
