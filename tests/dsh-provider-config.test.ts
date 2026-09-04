import assert from "node:assert/strict";
import test from "node:test";
import { coerceConfigFile } from "../src/dsh-provider-config.js";

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
