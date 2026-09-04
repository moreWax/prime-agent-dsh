import http from "node:http";

const port = Number(process.argv[2] ?? 0);
const stats = { requests: 0, toolRequests: 0, abortedRequests: 0, observations: [], toolsSeen: [], requestedToolNames: [], calledToolNames: [] };
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
  stats.requestedToolNames.push((body.tools ?? []).map((tool) => tool.function?.name ?? tool.name));
  const messages = body.messages ?? [];
  let commonPrefixMessages = 0;
  while (commonPrefixMessages < previousMessages.length && commonPrefixMessages < messages.length
    && JSON.stringify(previousMessages[commonPrefixMessages]) === JSON.stringify(messages[commonPrefixMessages])) commonPrefixMessages++;
  stats.observations.push({ messageCount: messages.length, previousMessageCount: previousMessages.length, commonPrefixMessages });
  if (stats.observations.length > 32) stats.observations.shift();
  previousMessages = structuredClone(messages);
  stats.toolsSeen = [...new Set([...(stats.toolsSeen ?? []), ...(body.tools ?? []).map((tool) => tool.function?.name).filter(Boolean)])];
  const flattened = JSON.stringify(messages);
  const latest = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  if (String(latest).includes("ABORT_SLOW")) {
    req.on("close", () => stats.abortedRequests++);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    if (res.destroyed) return;
  }
  let chunks;
  const toolCall = (id, name, args) => {
    stats.toolRequests++;
    return [
      { choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
  };
  if (String(latest).includes("SUBAGENT_PROBE") && !flattened.includes("embedded-child-ok")) {
    chunks = toolCall("call_subagent_probe", "subagent", { description: "embedded child probe", prompt: "CHILD_PROBE: reply exactly embedded-child-ok", run_in_background: false });
  } else if (String(latest).includes("WORKFLOW_PROBE") && !flattened.includes("workflow-child-ok")) {
    chunks = toolCall("call_workflow_probe", "workflow", {
      meta: { name: "embedded-probe", description: "One bounded child probe" },
      script: "const answer = await agent('WORKFLOW_CHILD_PROBE: reply exactly workflow-child-ok'); return { answer }",
    });
  } else if (String(latest).includes("JOBS_PROBE") && !flattened.includes("started background subagent job")) {
    chunks = toolCall("call_jobs_start_probe", "subagent_fork", { description: "background jobs probe", prompt: "JOB_CHILD_PROBE: reply exactly job-child-ok", run_in_background: true });
  } else if (String(latest).includes("JOBS_PROBE") && flattened.includes("started background subagent job") && !flattened.includes('"name":"job_output"')) {
    const match = flattened.match(/started background subagent job ([a-z]+-\d+)/);
    chunks = toolCall("call_jobs_output_probe", "job_output", { job_id: match?.[1] ?? "subagent-1", wait: true, timeout_ms: 5000 });
  const callTool = (name, args, id) => {
    stats.toolRequests++;
    stats.calledToolNames.push(name);
    return [
      { choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
  };
  else if (String(latest).includes("COMPACTION_PRUNE") && !flattened.includes("call_compact_bash")) {
    chunks = callTool("bash", { command: "node -e \"process.stdout.write('COMPACT_HEAD'+('MIDDLE_SECRET_'.repeat(24000))+'COMPACT_TAIL')\"", description: "Produce deterministic oversized tool output" }, "call_compact_bash");
    chunks.at(-1).usage = { prompt_tokens: 60000, completion_tokens: 2, total_tokens: 60002 };
  } else if (String(latest).includes("GOAL_PROBE") && !flattened.includes("call_goal_create")) {
    chunks = callTool("create_goal", { objective: "Ship deterministic bridge probe", max_goal_rounds: 2 }, "call_goal_create");
  } else if (String(latest).includes("GOAL_RECALL")) {
    if (!flattened.includes("call_goal_get")) chunks = callTool("get_goal", {}, "call_goal_get");
    else chunks = [
      { choices: [{ delta: { role: "assistant", content: "goal-persisted-ok" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    ];
  } else if (String(latest).includes("SKILL_PROBE") && !flattened.includes("BRIDGE_SKILL_SENTINEL")) {
    chunks = callTool("skill", { name: "integration-probe" }, "call_skill_load");

  } else if (String(latest).includes("ESCAPE_TOOL") && !flattened.includes("escape-attempt-finished")) {
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
    if (String(latest).includes("CHILD_PROBE")) text = "embedded-child-ok";
    else if (String(latest).includes("WORKFLOW_CHILD_PROBE")) text = "workflow-child-ok";
    else if (String(latest).includes("JOB_CHILD_PROBE")) text = "job-child-ok";
    else if (String(latest).includes("SUBAGENT_PROBE")) text = "parent-subagent-ok";
    else if (String(latest).includes("WORKFLOW_PROBE")) text = "parent-workflow-ok";
    else if (String(latest).includes("JOBS_PROBE")) text = flattened.includes("job-child-ok") ? "parent-jobs-ok" : "parent-jobs-missing";
    else if (Array.isArray(latest)
      && latest[0]?.type === "text" && latest[0].text === "IMAGE_TEST before"
      && latest.at(-2)?.type === "image_url" && latest.at(-2).image_url?.url?.startsWith("data:image/webp;base64,")
      && latest.at(-1)?.type === "text" && latest.at(-1).text === " after") text = "image-order-ok";
    else if (String(latest).includes("RECALL_TOKEN")) text = flattened.includes("COLD_ZEBRA") ? "COLD_ZEBRA" : flattened.includes("ZEBRA_XYZZY") ? "ZEBRA_XYZZY" : "missing";
    else if (String(latest).includes("COMPACTION_PRUNE")) text = flattened.includes("[... tool result middle pruned ...]") && flattened.includes("COMPACT_HEAD") && flattened.includes("COMPACT_TAIL") ? "compaction-pruned-ok" : "compaction-not-observed";
    else if (String(latest).includes("GOAL_PROBE") && flattened.includes("call_goal_create")) text = "goal-created-ok";
    else if (String(latest).includes("SKILL_PROBE") && flattened.includes("BRIDGE_SKILL_SENTINEL")) text = "skill-loaded-ok";

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
