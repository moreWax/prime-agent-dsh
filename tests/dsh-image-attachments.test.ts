import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AttachmentError } from "@deepseek-ai/dsh-attachment";
import { dshToPrimeAsync, primeToDshAsync } from "../src/context-converter.js";
import { LocalDshImageAttachments } from "../src/dsh-image-attachments.js";

// A valid 1x1 opaque PNG. DSH fully decodes it during admission.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function gateway(): Promise<LocalDshImageAttachments> {
  return new LocalDshImageAttachments({ dshHome: await mkdtemp(join(tmpdir(), "prime-dsh-image-")) });
}

test("real DSH store admits Prime image and resolves verified bytes", async () => {
  const attachments = await gateway();
  const [image] = await attachments.admitPrimeImages([{ data: PNG, mimeType: "image/png", name: "pixel.png" }]);
  assert.ok(image);
  assert.equal(image.mediaType, "image/webp");
  assert.equal(image.width, 1);
  assert.equal(image.height, 1);
  assert.equal(image.name, "pixel.png");
  assert.doesNotMatch(image.attachmentId, /prime-dsh-image/);
  const resolved = await attachments.resolveDshImage(image);
  assert.equal(resolved.mimeType, image.mediaType);
  assert.ok(resolved.data.length > 0);
});

test("async converter round trips Prime images through DSH attachment references", async () => {
  const attachments = await gateway();
  const prime = { role: "user", content: [{ type: "text", text: "see" }, { type: "image", data: PNG, mimeType: "image/png", name: "pixel.png" }] };
  const dsh = await primeToDshAsync(prime, { admitImages: (images) => attachments.admitPrimeImages(images) }, "message-1");
  assert.equal(dsh.content[1]?.type, "image");
  assert.equal("data" in (dsh.content[1] as object), false);
  const restored = await dshToPrimeAsync(dsh, { resolveImage: (image) => attachments.resolveDshImage(image) });
  const restoredMessage = restored as typeof prime;
  assert.equal(restoredMessage.role, prime.role);
  assert.deepEqual(restoredMessage.content[0], prime.content[0]);
  assert.deepEqual(restoredMessage.content[1], { type: "image", data: (restoredMessage.content[1] as { data: string }).data, mimeType: "image/webp", name: "pixel.png" });
});

test("admission rejects noncanonical base64 and unsupported media types with DSH errors", async () => {
  const attachments = await gateway();
  await assert.rejects(attachments.admitPrimeImages([{ data: "not base64", mimeType: "image/png" }]),
    (error: unknown) => error instanceof AttachmentError && error.code === "INVALID_IMAGE_BASE64");
  await assert.rejects(attachments.admitPrimeImages([{ data: PNG, mimeType: "image/svg+xml" }]),
    (error: unknown) => error instanceof AttachmentError && error.code === "UNSUPPORTED_IMAGE_TYPE");
});

test("resolution detects corruption through DSH reference verification", async () => {
  const attachments = await gateway();
  const [image] = await attachments.admitPrimeImages([{ data: PNG, mimeType: "image/png" }]);
  assert.ok(image);
  const path = attachments.store.imageHostPath(image);
  await chmod(path, 0o600);
  await writeFile(path, Buffer.from("corrupt"));
  await assert.rejects(attachments.resolveDshImage(image),
    (error: unknown) => error instanceof AttachmentError && error.code === "ATTACHMENT_CORRUPT");
});
