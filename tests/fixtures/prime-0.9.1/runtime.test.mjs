import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const primeRoot = "/home/xor/.npm-global/lib/node_modules/prime-agent";
const { AuthStorage } = await import(pathToFileURL(`${primeRoot}/dist/core/auth-storage.js`));
const { ModelRegistry } = await import(pathToFileURL(`${primeRoot}/dist/core/model-registry.js`));
const { getApiProvider } = await import(pathToFileURL(`${primeRoot}/node_modules/@earendil-works/pi-ai/dist/api-registry.js`));

test("installed Prime Agent 0.9.1 restores native API dispatch without changing catalog", () => {
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  const before = registry.getAll().filter((model) => model.provider === "openai");
  assert.ok(before.length > 0);
  const api = before[0].api;
  const native = getApiProvider(api)?.streamSimple;
  assert.equal(typeof native, "function");
  const wrapped = () => { throw new Error("fixture wrapper must not run"); };

  registry.registerProvider("dsh-transparent-openai-responses", { api, streamSimple: wrapped });
  assert.equal(getApiProvider(api)?.streamSimple === native, false);
  assert.deepEqual(registry.getAll().filter((model) => model.provider === "openai"), before);

  registry.unregisterProvider("dsh-transparent-openai-responses");
  assert.notEqual(getApiProvider(api)?.streamSimple, wrapped);
  assert.deepEqual(registry.getAll().filter((model) => model.provider === "openai"), before);

  // Duplicate cleanup is safe, as required for duplicate session_start.
  registry.unregisterProvider("dsh-transparent-openai-responses");
  assert.notEqual(getApiProvider(api)?.streamSimple, wrapped);
});
