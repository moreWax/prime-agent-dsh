import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { coerceConfigFile, coercePrimeMcpServers, mergeMcpServers } from "../src/dsh-provider-config.js";

test("accepts operator MCP declarations and persistent terminal opt-in", () => {
  const config = coerceConfigFile({ persistentTerminal: true, mcpServers: [
    { transport: "stdio", serverName: "local", command: "/usr/bin/node", args: ["server.js"], env: { TOKEN: "secret" }, cwd: "/tmp" },
    { transport: "streamable-http", serverName: "remote", url: "https://example.test/mcp", headers: { Authorization: "Bearer secret" } },
  ] }, "test");
  assert.equal(config.persistentTerminal, true);
  assert.equal(config.mcpServers?.length, 2);
});

test("rejects unsafe, malformed, and duplicate MCP declarations", () => {
  const config = coerceConfigFile({ mcpServers: [
    { transport: "stdio", serverName: "relative", command: "npx" },
    { transport: "streamable-http", serverName: "file", url: "file:///etc/passwd" },
    { transport: "streamable-http", serverName: "bad name", url: "https://example.test" },
    { transport: "stdio", serverName: "bad-env", command: "/bin/tool", env: { TOKEN: 42 } },
    { transport: "stdio", serverName: "same", command: "/bin/one" },
    { transport: "stdio", serverName: "same", command: "/bin/two" },
  ] }, "test");
  assert.deepEqual(config.mcpServers, [{ transport: "stdio", serverName: "same", command: "/bin/one" }]);
});

test("inherits enabled Prime settings.json MCP servers in DSH operator format", () => {
  const servers = coercePrimeMcpServers({
    "demo-search": { type: "stdio", command: "/usr/local/bin/demo-tool", args: ["serve", "--stdio"], enabled: true, startupTimeoutMs: 60000 },
    "vllm-orch": { type: "http", url: "http://localhost:8091/mcp", headers: { "X-Token": "secret" }, enabled: true },
    disabled: { type: "http", url: "http://localhost:9/mcp", enabled: false },
    relative: { type: "stdio", command: "zg" },
    "weird-type": { type: "sse", url: "http://localhost/mcp" },
    "bad entry": "not-an-object",
  }, "prime-settings");
  assert.deepEqual(servers, [
    { transport: "stdio", serverName: "demo-search", command: "/usr/local/bin/demo-tool", args: ["serve", "--stdio"], optional: true },
    { transport: "streamable-http", serverName: "vllm-orch", url: "http://localhost:8091/mcp", headers: { "X-Token": "secret" }, optional: true },
  ]);
});

test("explicit dsh.json MCP entries win over inherited Prime entries per serverName", () => {
  const merged = mergeMcpServers(
    [{ transport: "streamable-http", serverName: "demo-search", url: "http://127.0.0.1:7999/mcp" }],
    [
      { transport: "stdio", serverName: "demo-search", command: "/bin/demo-tool" },
      { transport: "stdio", serverName: "arxiv", command: "/bin/python" },
    ],
  );
  assert.deepEqual(merged, [
    { transport: "streamable-http", serverName: "demo-search", url: "http://127.0.0.1:7999/mcp" },
    { transport: "stdio", serverName: "arxiv", command: "/bin/python" },
  ]);
});


test("transparent wrapping is the package default and can be disabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-dsh-transparent-default-"));
  try {
    const fresh = (await import(`../src/dsh-provider-config.js?default-test=${Date.now()}`)) as {
      loadConfig: () => { transparent: boolean };
    };
    const explicit = (await import(`../src/dsh-provider-config.js?default-test2=${Date.now()}`)) as {
      loadConfig: () => { transparent: boolean };
    };
    process.env.PI_DSH_TRANSPARENT = "1";
    try {
      assert.equal(fresh.loadConfig().transparent, true);   // package default: on
      process.env.PI_DSH_TRANSPARENT = "";
      assert.equal(explicit.loadConfig().transparent, true); // file default: on
    } finally { delete process.env.PI_DSH_TRANSPARENT; }
    process.env.PI_DSH_TRANSPARENT = "0";
    try { assert.equal(explicit.loadConfig().transparent, false); } finally { delete process.env.PI_DSH_TRANSPARENT; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
