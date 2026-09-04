import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../dsh/", import.meta.url);
test("reverse DSH bundle uses the stock ACP provider with fail-closed defaults", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const patch = await readFile(new URL("cordis.patch.yml", root), "utf8");
  assert.equal(manifest.dependencies["@deepseek-ai/dsh-subagent-acp"], "0.1.2-alpha.5");
  assert.match(patch, /prime-agent-dsh-profile\/provider/);
  assert.match(patch, /command: prime-agent/);
  assert.match(patch, /permission: reject/);
  assert.match(patch, /'--no-session'/);
  assert.match(patch, /backgroundMode: one-shot/);
});


test("root lock pins one alpha.5 DSH graph and one pi-ai package", async () => {
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", root), "utf8"));
  const packages = Object.entries(lock.packages) as Array<[string, { version?: string }]>;
  const dshPackages = packages.filter(([path]) => /^node_modules\/@deepseek-ai\/dsh[^/]*$/.test(path));
  assert.ok(dshPackages.length > 100, "expected the complete DSH graph in the lock");
  assert.deepEqual([...new Set(dshPackages.map(([, entry]) => entry.version))], ["0.1.2-alpha.5"]);
  assert.equal(new Set(packages.filter(([path]) => path.endsWith("node_modules/@earendil-works/pi-ai")).map(([, entry]) => entry.version)).size, 1);
  assert.equal(lock.packages["node_modules/@deepseek-ai/cordis"].version, "4.0.2");
});
