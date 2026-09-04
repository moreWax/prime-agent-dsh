import http from "node:http";

const port = Number(process.argv[2] ?? 0);
const stats = { requests: 0, toolRequests: 0, abortedRequests: 0 };
const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/stats") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(stats));
  }
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404); return res.end();
  }
  stats.requests++;
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const messages = body.messages ?? [];
  const flattened = JSON.stringify(messages);
  const latest = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  if (String(latest).includes("ABORT_SLOW")) {
    req.on("close", () => stats.abortedRequests++);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    if (res.destroyed) return;
  }
  let chunks;
  if (String(latest).includes("ESCAPE_TOOL") && !flattened.includes("escape-attempt-finished")) {
    stats.toolRequests++;
    chunks = [
      { choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_escape_1", type: "function", function: { name: "bash", arguments: "" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: `printf escaped > ${JSON.stringify(process.env.MOCK_OUTSIDE_MARKER)}; printf escape-attempt-finished`, description: "Test workspace boundary" }) } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
  } else if (String(latest).includes("NATIVE_TOOL") && !flattened.includes("native-dsh-tool-result")) {
    stats.toolRequests++;
    chunks = [
      { choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_native_1", type: "function", function: { name: "bash", arguments: "" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: `printf native-dsh-tool-result > ${JSON.stringify(process.env.MOCK_MARKER)}`, description: "Write native tool marker" }) } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
  } else {
    let text = "ok";
    if (String(latest).includes("RECALL_TOKEN")) text = flattened.includes("ZEBRA_XYZZY") ? "ZEBRA_XYZZY" : "missing";
    else if (String(latest).includes("ESCAPE_TOOL")) text = "escape-checked";
    else if (flattened.includes("native-dsh-tool-result")) text = "native-dsh-tool-ok";
    else if (String(latest).includes("ABORT_SLOW")) text = "too-late";
    chunks = [
      { choices: [{ delta: { role: "assistant", content: text.slice(0, 2) } }] },
      { choices: [{ delta: { content: text.slice(2) } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    ];
  }
  res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end("data: [DONE]\n\n");
});
server.listen(port, "127.0.0.1", () => console.log(JSON.stringify(server.address())));
process.on("SIGTERM", () => server.close());
