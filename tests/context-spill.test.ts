import assert from "node:assert/strict";
import { chmod, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
import type { FileAttachmentRef } from "@deepseek-ai/dsh-attachment";
import { DurableFileAttachments } from "../src/durable-file-attachments.js";
import { resolveContextSpill, spillContextText } from "../src/context-spill.js";

async function repository(overrides: Partial<ConstructorParameters<typeof DurableFileAttachments>[0]> = {}) {
  const dshHome = await mkdtemp(join(tmpdir(), "dsh-spill-"));
  return { dshHome, files: new DurableFileAttachments({ dshHome, ...overrides }) };
}

test("oversized Unicode text gets bounded preview and survives a new repository", async () => {
  const { dshHome, files } = await repository();
  const original = "🙂漢字".repeat(2_000);
  const result = await spillContextText(files, original, { thresholdBytes: 10, previewBytes: 100 });
  assert.equal(result.spilled, true);
  assert.ok(Buffer.byteLength(result.text) <= 100);
  assert.doesNotThrow(() => new TextEncoder().encode(result.text));
  if (!result.spilled) return;
  const restarted = new DurableFileAttachments({ dshHome });
  assert.equal(await resolveContextSpill(restarted, result.locator), original);
  assert.equal((await restarted.usage()).objects, 1);
});

test("same bytes deduplicate while allowing generic sanitized filenames", async () => {
  const { files } = await repository();
  const data = new TextEncoder().encode("same bytes");
  const a = await files.save(data, "../../tool.txt");
  const b = await files.save(data, "model.bin");
  assert.equal(a.attachmentId, b.attachmentId);
  assert.equal(a.name, "tool.txt");
  assert.equal((await files.usage()).objects, 1);
  assert.deepEqual(await files.read(b), data);
  assert.equal((await readFile(files.hostPath(a))).toString(), "same bytes");
});

test("digest corruption, traversal references, and replaced symlinks are rejected", async () => {
  const { files } = await repository();
  const ref = await files.save(new TextEncoder().encode("secret"), "data.txt");
  await chmod(files.hostPath(ref), 0o600);
  await writeFile(files.hostPath(ref), "broken");
  await assert.rejects(files.read(ref), /integrity|corrupt/i);

  const traversal = { ...ref, name: "../data.txt" } as FileAttachmentRef;
  assert.throws(() => files.hostPath(traversal), /invalid/i);

  const other = await files.save(new TextEncoder().encode("elsewhere"), "link.txt");
  const path = files.hostPath(other);
  await chmod(path, 0o600); await (await import("node:fs/promises")).unlink(path);
  await symlink("/etc/hosts", path);
  await assert.rejects(files.read(other), /symlink/i);
});

test("quota refusal fails open for context and cleanup reclaims unretained objects", async () => {
  const { files } = await repository({ maxTotalBytes: 8, maxObjectBytes: 100 });
  const keep = await files.save(new TextEncoder().encode("12345678"), "keep.txt");
  const original = "long result that cannot fit";
  const result = await spillContextText(files, original, { thresholdBytes: 1, previewBytes: 8 });
  assert.deepEqual(result, { text: original, spilled: false });
  const cleaned = await files.cleanup([]);
  assert.equal(cleaned.removedObjects, 1);
  assert.equal(cleaned.objects, 0);
  const next = await files.save(new TextEncoder().encode("new"), "next.txt");
  assert.notEqual(next.attachmentId, keep.attachmentId);
});

test("write failures leave exact original text inline", async () => {
  const original = "🙂 original";
  const result = await spillContextText({ save: async () => { throw new Error("disk full"); } }, original, { thresholdBytes: 1 });
  assert.deepEqual(result, { text: original, spilled: false });
});


test("lone surrogate text is never lossy-spilled",async()=>{
 const value="before\ud800after";let saves=0;const result=await spillContextText({save:async()=>{saves++;throw new Error("must not write")}} as never,value,{thresholdBytes:1});assert.deepEqual(result,{text:value,spilled:false});assert.equal(saves,0);
});
