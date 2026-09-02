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
