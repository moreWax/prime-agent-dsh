import assert from "node:assert/strict";
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
    "zvec-grep": { type: "stdio", command: "/home/xor/.npm-global/bin/zg", args: ["server", "--stdio"], enabled: true, startupTimeoutMs: 60000 },
    "vllm-orch": { type: "http", url: "http://localhost:8091/mcp", headers: { "X-Token": "secret" }, enabled: true },
    disabled: { type: "http", url: "http://localhost:9/mcp", enabled: false },
    relative: { type: "stdio", command: "zg" },
    "weird-type": { type: "sse", url: "http://localhost/mcp" },
    "bad entry": "not-an-object",
  }, "prime-settings");
  assert.deepEqual(servers, [
    { transport: "stdio", serverName: "zvec-grep", command: "/home/xor/.npm-global/bin/zg", args: ["server", "--stdio"] },
    { transport: "streamable-http", serverName: "vllm-orch", url: "http://localhost:8091/mcp", headers: { "X-Token": "secret" } },
  ]);
});

test("explicit dsh.json MCP entries win over inherited Prime entries per serverName", () => {
  const merged = mergeMcpServers(
    [{ transport: "streamable-http", serverName: "zvec-grep", url: "http://127.0.0.1:7999/mcp" }],
    [
      { transport: "stdio", serverName: "zvec-grep", command: "/bin/zg" },
      { transport: "stdio", serverName: "arxiv", command: "/bin/python" },
    ],
  );
  assert.deepEqual(merged, [
    { transport: "streamable-http", serverName: "zvec-grep", url: "http://127.0.0.1:7999/mcp" },
    { transport: "stdio", serverName: "arxiv", command: "/bin/python" },
  ]);
});


test("modular default: transparent provider wrapping stays off unless opted in", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "pi-dsh-config-"));
  const saved = { ...process.env };
  process.env.PRIME_AGENT_HOME = home;
  delete process.env.PI_DSH_TRANSPARENT;
  try {
    const fresh = (await import(`../src/dsh-provider-config.js?case=${Date.now()}`)) as {
      loadConfig: () => { transparent: boolean };
    };
    assert.equal(fresh.loadConfig().transparent, false);
    process.env.PI_DSH_TRANSPARENT = "1";
    assert.equal(fresh.loadConfig().transparent, true);
    process.env.PI_DSH_TRANSPARENT = "0";
    assert.equal(fresh.loadConfig().transparent, false);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) process.env[key] = value;
  }
});
