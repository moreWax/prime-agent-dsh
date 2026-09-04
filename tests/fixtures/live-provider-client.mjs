import { readFileSync } from "node:fs";
import { registerProvider, createInstanceRuntime } from "../../src/dsh-provider.ts";
import { preparePrimeRoute } from "../../src/model-route.ts";

const [home, workspace, baseUrl, sessionKey, provider, prompt] = process.argv.slice(2);
if (!home || !workspace || !baseUrl || !sessionKey || !provider || !prompt) throw new Error("missing cold-resume fixture argument");
process.env.DSH_HOME = home;
process.env.DSH_TELEMETRY_DISABLED = "1";
const nativeModel = {
  id: "mock-1", name: "Deterministic Mock", provider,
  api: "openai-completions", baseUrl, reasoning: false, input: ["text"],
  contextWindow: 65536, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const route = await preparePrimeRoute({ model: nativeModel, auth: { apiKey: "fixture-key" } }, home);
try {
  const runtime = createInstanceRuntime();
  runtime.cwd = workspace;
  runtime.sessionKey = sessionKey;
  runtime.resolveRoute = async () => route;
  let registration;
  registerProvider({ registerProvider(name, config) { registration = { name, config }; } }, {
    dshBin: "unused", timeoutMs: 30_000, mode: "pool", poolMax: 1,
    poolIdleTtlMs: 60_000, fullAccess: false, transparent: true, mcpServers: [], persistentTerminal: false,
  }, runtime);
  if (!registration) throw new Error("provider registration missing");
  const model = { ...registration.config.models[0], provider: "dsh", api: "dsh-exec" };
  const stream = registration.config.streamSimple(model, {
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }], tools: [],
  }, { sessionId: sessionKey });
  for await (const _event of stream) { /* drain */ }
  const result = await stream.result();
  const text = (result?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
  process.stdout.write(JSON.stringify({ text, stopReason: result?.stopReason, errorMessage: result?.errorMessage, usage: result?.usage, routeFingerprint: route.fingerprint }) + "\n");
} finally {
  await route.proxy.close();
}
process.exit(0);
