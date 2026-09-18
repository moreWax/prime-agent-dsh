import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const codingAgentDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { ModelRegistry } = await import(pathToFileURL(join(codingAgentDist, "core/model-registry.js")));
const { ModelRuntime } = await import(pathToFileURL(join(codingAgentDist, "core/model-runtime.js")));
const { getApiProvider } = await import("@earendil-works/pi-ai/compat");

test("installed Prime compatibility surface restores native API dispatch without changing catalog", async () => {
  const registry = new ModelRegistry(await ModelRuntime.create());
  const before = registry.getAll().filter((model) => model.provider === "openai");
  assert.ok(before.length > 0);
  const api = before[0].api;
  const native = getApiProvider(api)?.streamSimple;
  assert.equal(typeof native, "function");
  const wrapped = () => { throw new Error("fixture wrapper must not run"); };

  registry.registerProvider("dsh-transparent-openai-responses", { api, streamSimple: wrapped });
  assert.equal(registry.getRegisteredProviderConfig("dsh-transparent-openai-responses")?.streamSimple, wrapped);
  assert.deepEqual(registry.getAll().filter((model) => model.provider === "openai"), before);

  registry.unregisterProvider("dsh-transparent-openai-responses");
  assert.equal(registry.getRegisteredProviderConfig("dsh-transparent-openai-responses"), undefined);
  assert.equal(getApiProvider(api)?.streamSimple, native);
  assert.deepEqual(registry.getAll().filter((model) => model.provider === "openai"), before);

  // Duplicate cleanup is safe, as required for duplicate session_start.
  registry.unregisterProvider("dsh-transparent-openai-responses");
  assert.equal(registry.getRegisteredProviderConfig("dsh-transparent-openai-responses"), undefined);
});
