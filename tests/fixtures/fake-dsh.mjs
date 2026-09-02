#!/usr/bin/env node
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
let next = 0;
const sessions = new Set();
const app = acp.agent({ name: "fake-dsh-alpha5" })
  .onRequest(acp.methods.agent.initialize, ({ params }) => ({ protocolVersion: params.protocolVersion,
    agentCapabilities: { promptCapabilities: { image: true }, sessionCapabilities: { resume: true, close: true } } }))
  .onRequest(acp.methods.agent.session.new, () => { const sessionId = `s-${++next}`; sessions.add(sessionId); return { sessionId }; })
  .onRequest(acp.methods.agent.session.resume, ({ params }) => { sessions.add(params.sessionId); return {}; })
  .onRequest(acp.methods.agent.session.close, ({ params }) => { sessions.delete(params.sessionId); return {}; })
  .onNotification(acp.methods.agent.session.cancel, () => {})
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const permission = await client.request(acp.methods.client.session.requestPermission, { sessionId: params.sessionId,
      toolCall: { toolCallId: "t", title: "write", status: "pending" },
      options: [{ optionId: "yes", name: "yes", kind: "allow_once" }] });
    const images = params.prompt.filter((p) => p.type === "image").length;
    const choice = permission.outcome.outcome === "selected" ? permission.outcome.optionId : "cancel";
    await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId,
      update: { sessionUpdate: "tool_call", toolCallId: "t", title: "write", status: "completed" } });
    await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `ok:${choice}:images=${images}` } } });
    return { stopReason: "end_turn" };
  });
app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
