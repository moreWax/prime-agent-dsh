import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("loads isolated defaults", () => {
  const old = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith("PRIME_DSH_")) delete process.env[key];
  try {
    const config = loadConfig("/tmp/work");
    assert.equal(config.profile, "sdk");
    assert.equal(config.provider, "deepseek-official");
    assert.equal(config.model, "deepseek-v4-flash");
    assert.ok(config.dshHome.includes("deepseek-harness"));
  } finally {
    process.env = old;
  }
});
