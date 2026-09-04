import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { preparePrimeRoute } from "../src/model-route.js";

const model: Model<Api> = { provider: "prime-test", id: "same-model", name: "Same Model", api: "openai-completions",
  baseUrl: "http://127.0.0.1:4027/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000, maxTokens: 4096 };

test("Prime inference proxy keeps credentials out of DSH patch and injects them upstream", async () => {
  let authorization: string | undefined;
  const upstream = createServer((request, response) => { authorization = request.headers.authorization; response.writeHead(200, { "content-type": "application/json" }); response.end('{"ok":true}'); });
  await new Promise<void>((resolve) => upstream.listen(4027, "127.0.0.1", resolve));
  const home = "/tmp/prime-agent-dsh-route-test"; await rm(home, { recursive: true, force: true });
  const route = await preparePrimeRoute({ model, auth: { apiKey: "upstream-secret" } }, home);
  try {
    const patch = await readFile(route.patch, "utf8");
    assert.doesNotMatch(patch, /upstream-secret/);
    assert.match(patch, /prime-selected-/);
    assert.doesNotMatch(await readFile(route.modelPatch, "utf8"), /acpAppStartup/);
    assert.deepEqual(Object.keys(route.env), [`PRIME_DSH_PROXY_TOKEN_${route.fingerprint.toUpperCase()}`]);
    const response = await fetch(`${route.proxy.baseUrl}/v1/models`, { headers: { authorization: `Bearer ${route.proxy.token}` } });
    assert.equal(response.status, 200);
    assert.equal(authorization, "Bearer upstream-secret");
    const denied = await fetch(`${route.proxy.baseUrl}/v1/models`, { headers: { authorization: "Bearer wrong" } });
    assert.equal(denied.status, 401);
  } finally { await route.proxy.close(); await new Promise<void>((resolve) => upstream.close(() => resolve())); }
});

test("unsupported Prime model APIs fail instead of being relabeled", async () => {
  await assert.rejects(preparePrimeRoute({ model: { ...model, api: "google-generative-ai" }, auth: {} }, "/tmp/prime-agent-dsh-bad-route"), /cannot be represented/);
});


test("route identity includes native model route but excludes credentials", async () => {
  const home = "/tmp/prime-agent-dsh-route-identity-test"; await rm(home, { recursive: true, force: true });
  const first = await preparePrimeRoute({ model, auth: { apiKey: "first-secret" } }, home);
  const same = await preparePrimeRoute({ model, auth: { apiKey: "second-secret" } }, home);
  const switched = await preparePrimeRoute({ model: { ...model, provider: "other-prime-provider" }, auth: {} }, home);
  try {
    assert.equal(first.fingerprint, same.fingerprint);
    assert.notEqual(first.fingerprint, switched.fingerprint);
    assert.notEqual(first.provider, switched.provider);
    for (const route of [first, same, switched]) {
      const persisted = (await readFile(route.patch, "utf8")) + (await readFile(route.modelPatch, "utf8"));
      assert.doesNotMatch(persisted, /first-secret|second-secret/);
    }
  } finally { await Promise.all([first.proxy.close(), same.proxy.close(), switched.proxy.close()]); }
});


test("reasoning efforts follow Prime's model map and drop undispatchable wire values", async () => {
  const home = "/tmp/prime-agent-dsh-reasoning-route-test"; await rm(home, { recursive: true, force: true });
  const reasoningModel = { ...model, reasoning: true,
    thinkingLevelMap: { off: null, minimal: "", medium: "medium", high: "high" } } as Model<Api>;
  const route = await preparePrimeRoute({ model: reasoningModel, auth: {} }, home);
  try {
    const patchText = await readFile(route.modelPatch, "utf8");
    // "off" and concrete wire values survive; the empty-wire "minimal" level is dropped
    assert.doesNotMatch(patchText, /"minimal"/);
    assert.match(patchText, /"off"/);
    assert.match(patchText, /"medium"/);
    assert.match(patchText, /"high"/);
  } finally { await route.proxy.close(); }
});
