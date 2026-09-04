import assert from "node:assert/strict";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import test from "node:test";
import { createPrivateRootConfig } from "../src/dsh-provider-security.js";
import { coerceFullAccess } from "../src/dsh-provider-config.js";

test("full access requires the exact documented opt-in", () => {
  assert.equal(coerceFullAccess(undefined), undefined);
  assert.equal(coerceFullAccess("1"), true);
  assert.equal(coerceFullAccess("0"), false);
  for (const value of ["true", "yes", "01", " 1 ", ""]) assert.equal(coerceFullAccess(value), undefined);
});

test("Loader root resists predictable-name and symlink attacks", () => {
  const first = createPrivateRootConfig();
  const second = createPrivateRootConfig();
  try {
    assert.notEqual(first.path, second.path);
    const dir = dirname(first.path);
    assert.equal(dirname(dir), tmpdir());
    assert.equal(lstatSync(dir).isSymbolicLink(), false);
    assert.equal(lstatSync(first.path).isSymbolicLink(), false);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(first.path).mode & 0o777, 0o600);
    assert.equal(readFileSync(first.path, "utf8"), "[]\n");
  } finally {
    first.cleanup(); second.cleanup();
  }
});
