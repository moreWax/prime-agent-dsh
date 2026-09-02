import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DshAcpClient } from "../src/acp-client.js";

const fake = fileURLToPath(new URL("./fixtures/fake-dsh.mjs", import.meta.url));

test("ACP lifecycle, semantic updates, permissions, resume, images, and close", async () => {
  const seen: string[] = [];
  const client = new DshAcpClient({ cwd: process.cwd(), dshBin: fake,
    permission: ({ options }) => ({ outcome: { outcome: "selected", optionId: options[0].optionId } }),
    onUpdate: ({ update }) => { seen.push(update.sessionUpdate); },
  });
  try {
    const init = await client.start();
    assert.equal(init.protocolVersion, 1);
    const sessionId = await client.newSession();
    const result = await client.prompt(sessionId, [
      { type: "text", text: "inspect" },
      { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
    ]);
    assert.equal(result.text, "ok:yes:images=1");
    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(seen, ["tool_call", "agent_message_chunk"]);
    await client.closeSession(sessionId);
    await client.resumeSession(sessionId);
  } finally { await client.close(); }
});

test("stderr is tail-bounded", async () => {
  const client = new DshAcpClient({ cwd: process.cwd(), dshBin: "/definitely/missing", stderrLimitBytes: 8 });
  await assert.rejects(client.start());
  await client.close();
});
