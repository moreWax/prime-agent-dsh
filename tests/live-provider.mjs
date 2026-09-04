import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { registerProvider, createInstanceRuntime } from "../src/dsh-provider.ts";
import { preparePrimeRoute } from "../src/model-route.ts";
import { createPrivateRootConfig } from "../src/dsh-provider-security.ts";
import { TransparentProviderController } from "../src/transparent-provider.ts";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), "prime-agent-dsh-live-"));
const home = join(root, "dsh-home");
const workspace = join(root, "workspace");
mkdirSync(home); mkdirSync(workspace);
const skillDir = join(workspace, ".dsh", "skills", "integration-probe");
mkdirSync(skillDir, { recursive: true });
writeFileSync(join(skillDir, "SKILL.md"), `---
name: integration-probe
description: Deterministic embedded bridge integration probe.
---
Return BRIDGE_SKILL_SENTINEL to prove this body was loaded by DSH.
`);
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
async function coldTurn(sessionKey, provider, prompt) {
  const child = spawn(process.execPath, ["--import", "tsx", join(here, "tests/fixtures/live-provider-client.mjs"),
    home, workspace, baseUrl, sessionKey, provider, prompt], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  if (code !== 0) throw new Error(`cold provider child exited ${code}: ${stderr}`);
  const line = stdout.trim().split("\n").at(-1);
  if (!line) throw new Error("cold provider child returned no result");
  return JSON.parse(line);
}

let route;
try {
  const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
  check("embedded DSH remains pinned to alpha.5", () => {
    assert.equal(pkg.dependencies["@deepseek-ai/dsh-app-boot"], "0.1.2-alpha.5");
    const dshDependencies = Object.entries(pkg.dependencies).filter(([name]) => name.startsWith("@deepseek-ai/dsh"));
    assert.ok(dshDependencies.length > 100);
    assert.ok(dshDependencies.every(([, version]) => version === "0.1.2-alpha.5"));
  });

  const nativeModel = {
    id: "mock-1", name: "Deterministic Mock", provider: "mock-local",
    api: "openai-completions", baseUrl, reasoning: false, input: ["text", "image"],
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
    poolIdleTtlMs: 60_000, fullAccess: false, transparent: true, mcpServers: [], persistentTerminal: false,
  }, runtime);

  check("actual dsh provider registers", () => assert.equal(registration?.name, "dsh"));
  check("actual provider exposes streamSimple", () => assert.equal(typeof registration?.config.streamSimple, "function"));
  check("catalog preserves stable harness identity", () => assert.equal(registration?.config.models[0].id, "dsh-harness"));
  check("Prime route uses loopback capability proxy", () => {
    assert.match(route.proxy.baseUrl, /^http:\/\/127\.0\.0\.1:/);
    assert.ok(!readFileSync(route.modelPatch, "utf8").includes("not-a-vendor-key"));
  });

  const model = { ...registration.config.models[0], provider: "dsh", api: "dsh-exec" };
  async function turn(content, signal) {
    const stream = registration.config.streamSimple(model, {
      messages: [{ role: "user", content, timestamp: Date.now() }], tools: [],
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

  const cacheFirst = await turn("PREFIX_CACHE first");
  const cacheSecond = await turn("PREFIX_CACHE second");
  const cacheStats = await stats();
  const [firstEnvelope, secondEnvelope] = cacheStats.observations.slice(-2);
  check("repeated-prefix requests expose the actual provider envelope prefix", () => {
    assert.ok(firstEnvelope.messageCount > 0);
    assert.ok(secondEnvelope.commonPrefixMessages > 0);
    assert.ok(secondEnvelope.messageCount > firstEnvelope.messageCount);
  });
  check("cache metrics are provider-reported, not inferred from prefix similarity", () => {
    assert.equal(cacheFirst.result.usage.cacheRead, 8);
    assert.equal(cacheSecond.result.usage.cacheRead, 8);
  });

  const coldSession = `cold-${Date.now()}`;
  const coldSeed = await coldTurn(coldSession, "mock-cold-a", "Remember COLD_ZEBRA. Reply ok.");
  const coldRecall = await coldTurn(coldSession, "mock-cold-a", "RECALL_TOKEN");
  check("persisted DSH projection resumes after a real process cold restart", () => {
    assert.equal(coldSeed.stopReason, "stop", coldSeed.errorMessage);
    assert.equal(coldRecall.text, "COLD_ZEBRA");
    assert.equal(coldRecall.stopReason, "stop", coldRecall.errorMessage);
  });
  const switchedRoute = await coldTurn(coldSession, "mock-cold-b", "RECALL_TOKEN");
  check("changing the native model route isolates the persisted session", () => {
    assert.notEqual(coldSeed.routeFingerprint, switchedRoute.routeFingerprint);
    assert.notEqual(switchedRoute.text, "COLD_ZEBRA");
  });
  const image = await turn([
    { type: "text", text: "IMAGE_TEST before" },
    { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", mimeType: "image/png" },
    { type: "text", text: " after" },
  ]);
  check("pooled turn admits and routes a live deterministic image", () => assert.equal(image.text, "image-order-ok"));

  const subagent = await turn("SUBAGENT_PROBE: delegate the probe through subagent and report success.");
  check("embedded DSH runs a deterministic foreground subagent", () => assert.equal(subagent.text, "parent-subagent-ok"));
  const workflow = await turn("WORKFLOW_PROBE: run the requested one-child workflow and report success.");
  check("embedded DSH runs a bounded worker-thread workflow", () => assert.equal(workflow.text, "parent-workflow-ok"));
  const jobs = await turn("JOBS_PROBE: start the child in the background, collect it with job_output, then report success.");
  check("embedded DSH starts and collects a background child job", () => assert.equal(jobs.text, "parent-jobs-ok"));
  const behavioralStats = await stats();
  check("embedded tree exposes the three probed model tool surfaces", () => {
    for (const name of ["subagent", "workflow", "job_output", "job_list", "job_kill"])
      assert.ok(behavioralStats.toolsSeen.includes(name), `missing ${name}`);
  });
  const beforeBehavior = await stats();
  const skill = await turn("SKILL_PROBE load integration-probe.");
  check("embedded DSH advertises and executes its skill tool", () => {
    assert.equal(skill.text, "skill-loaded-ok");
    assert.ok(!skill.events.some((type) => type.startsWith("toolcall_")));
  });
  const goalCreate = await turn("GOAL_PROBE create the requested durable goal.");
  check("embedded DSH executes its persisted goal tool", () => {
    assert.equal(goalCreate.text, "goal-created-ok");
    assert.ok(!goalCreate.events.some((type) => type.startsWith("toolcall_")));
  });
  const goalRecall = await turn("GOAL_RECALL inspect the same-session goal.");
  const afterBehavior = await stats();
  check("DSH goal state survives a later transparent turn", () => assert.match(goalRecall.text, /goal-persisted-ok/));
  check("behavior probes used DSH internal tools and exposed no Prime tool calls", () => {
    assert.deepEqual(afterBehavior.calledToolNames.slice(beforeBehavior.calledToolNames.length), ["skill", "create_goal", "get_goal"]);
    const advertised = afterBehavior.requestedToolNames.slice(beforeBehavior.requestedToolNames.length).flat();
    assert.ok(advertised.includes("skill") && advertised.includes("create_goal") && advertised.includes("get_goal"));
    assert.ok(![...skill.events, ...goalCreate.events, ...goalRecall.events].some((type) => type.startsWith("toolcall_")));
  });

  const beforeCompact = await stats();
  const compacted = await turn("COMPACTION_PRUNE exercise DSH-owned tool result compaction.");
  const afterCompact = await stats();
  check("embedded DSH prunes oversized internal tool results before the next model step", () => {
    assert.equal(compacted.text, "compaction-pruned-ok");
    assert.equal(afterCompact.requests - beforeCompact.requests, 2);
    assert.deepEqual(afterCompact.calledToolNames.slice(beforeCompact.calledToolNames.length), ["bash"]);
    assert.ok(!compacted.events.some((type) => type.startsWith("toolcall_")));

  });

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

  // Host-level acceptance for the transparent UX: the selected model stays
  // native/native-id while the provider stream enters the same DSH pool.
  const nativeProvider = {
    id: "mock-local", name: "Mock Local", auth: { apiKey: {
      name: "key", login: async () => ({ type: "api_key", key: "x" }),
      check: async () => ({ type: "api_key", source: "mock" }),
      resolve: async () => ({ auth: { apiKey: "not-a-vendor-key" }, source: "mock" }),
    } },
    getModels: () => [nativeModel],
    stream: () => { throw new Error("native stream must not run while transparent wrapping is enabled"); },
    streamSimple: () => { throw new Error("native stream must not run while transparent wrapping is enabled"); },
  };
  let transparentProvider;
  const transparentSessionId = `transparent-${Date.now()}`;
  const transparentCtx = {
    cwd: workspace, thinkingLevel: "off", hasUI: false,
    sessionManager: { getSessionId: () => transparentSessionId },
    modelRegistry: {
      getAll: () => [nativeModel], getProvider: () => nativeProvider,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "not-a-vendor-key" }),
    },
  };
  const transparent = new TransparentProviderController({
    on() {}, registerCommand() {}, registerProvider(provider) { transparentProvider = provider; },
  }, { dshBin: "unused", timeoutMs: 30_000, mode: "pool", poolMax: 2,
    poolIdleTtlMs: 60_000, fullAccess: false, transparent: true, mcpServers: [], persistentTerminal: false }, { dshHome: () => home });
  transparent.register();
  transparent.captureAndPublish(transparentCtx);
  check("transparent wrapper preserves normal provider and model ids", () => {
    assert.equal(transparentProvider.id, "mock-local");
    assert.equal(transparentProvider.getModels()[0].id, "mock-1");
    assert.equal(transparentProvider.auth, nativeProvider.auth);
  });
  const transparentStream = transparentProvider.stream(nativeModel, {
    messages: [{ role: "user", content: "Reply transparent-ok.", timestamp: Date.now() }], tools: [],
  }, { sessionId: transparentCtx.sessionManager.getSessionId() });
  const transparentEvents = [];
  for await (const event of transparentStream) transparentEvents.push(event.type);
  const transparentResult = await transparentStream.result();
  check("normal native selection executes through in-process DSH", () => {
    assert.equal(transparentResult.stopReason, "stop", transparentResult.errorMessage);
    assert.ok(transparentEvents.includes("text_delta"));
  });

  async function transparentTurn(content) {
    const stream = transparentProvider.stream(nativeModel, {
      messages: [{ role: "user", content, timestamp: Date.now() }], tools: [],
    }, { sessionId: transparentCtx.sessionManager.getSessionId() });
    const events = [];
    for await (const event of stream) events.push(event.type);
    const result = await stream.result();
    return { result, events, text: (result?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("") };
  }
  const transparentBefore = await stats();
  const transparentSkill = await transparentTurn("SKILL_PROBE load integration-probe through transparent routing.");
  const transparentGoal = await transparentTurn("GOAL_PROBE create the transparent durable goal.");
  const transparentGoalRecall = await transparentTurn("GOAL_RECALL inspect the transparent same-session goal.");
  const transparentCompact = await transparentTurn("COMPACTION_PRUNE exercise transparent DSH-owned compaction.");
  const transparentAfter = await stats();
  check("transparent DSH owns skill, goal, and compaction tool loops", () => {
    assert.equal(transparentSkill.text, "skill-loaded-ok");
    assert.equal(transparentGoal.text, "goal-created-ok");
    assert.match(transparentGoalRecall.text, /goal-persisted-ok/);
    assert.equal(transparentCompact.text, "compaction-pruned-ok");
    assert.deepEqual(transparentAfter.calledToolNames.slice(transparentBefore.calledToolNames.length), ["skill", "create_goal", "get_goal", "bash"]);
    assert.ok(![...transparentSkill.events, ...transparentGoal.events, ...transparentGoalRecall.events, ...transparentCompact.events].some((type) => type.startsWith("toolcall_")));
  });

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
