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
    assert.match(patch, /prime-selected/);
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
