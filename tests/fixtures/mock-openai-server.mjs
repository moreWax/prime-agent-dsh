import http from "node:http";

const port = Number(process.argv[2] ?? 0);
const stats = { requests: 0, toolRequests: 0, abortedRequests: 0, observations: [] };
let previousMessages = [];
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
  let commonPrefixMessages = 0;
  while (commonPrefixMessages < previousMessages.length && commonPrefixMessages < messages.length
    && JSON.stringify(previousMessages[commonPrefixMessages]) === JSON.stringify(messages[commonPrefixMessages])) commonPrefixMessages++;
  stats.observations.push({ messageCount: messages.length, previousMessageCount: previousMessages.length, commonPrefixMessages });
  if (stats.observations.length > 32) stats.observations.shift();
  previousMessages = structuredClone(messages);
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
    if (Array.isArray(latest)
      && latest[0]?.type === "text" && latest[0].text === "IMAGE_TEST before"
      && latest.at(-2)?.type === "image_url" && latest.at(-2).image_url?.url?.startsWith("data:image/webp;base64,")
      && latest.at(-1)?.type === "text" && latest.at(-1).text === " after") text = "image-order-ok";
    else if (String(latest).includes("RECALL_TOKEN")) text = flattened.includes("COLD_ZEBRA") ? "COLD_ZEBRA" : flattened.includes("ZEBRA_XYZZY") ? "ZEBRA_XYZZY" : "missing";
    else if (String(latest).includes("ESCAPE_TOOL")) text = "escape-checked";
    else if (flattened.includes("native-dsh-tool-result")) text = "native-dsh-tool-ok";
    else if (String(latest).includes("ABORT_SLOW")) text = "too-late";
    chunks = [
      { choices: [{ delta: { role: "assistant", content: text.slice(0, 2) } }] },
      { choices: [{ delta: { content: text.slice(2) } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: String(latest).includes("PREFIX_CACHE") ? 8 : 0 } } },
    ];
  }
  res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.end("data: [DONE]\n\n");
});
server.listen(port, "127.0.0.1", () => console.log(JSON.stringify(server.address())));
process.on("SIGTERM", () => server.close());
