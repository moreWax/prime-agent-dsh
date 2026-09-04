import { Buffer } from "node:buffer";
import { Context } from "@deepseek-ai/cordis";
import {
  AttachmentError,
  admitEncodedImages,
  type AttachmentStore,
  type EncodedImageAttachment,
  type ImageAttachmentRef,
  type ImageMediaType,
} from "@deepseek-ai/dsh-attachment";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { LocalAttachmentStore, type Config as LocalAttachmentConfig } from "@deepseek-ai/dsh-attachment-local";

/** Inline image block used by Prime's model context. */
export interface PrimeInlineImage {
  readonly data: string;
  readonly mimeType: string;
  readonly name?: string;
}

/** Ordered image block in a Prime user turn. */
export type PrimeTurnImage = PrimeInlineImage & { readonly type: "image" };

/** Resolved inline bytes suitable for a Prime image content block. */
export interface ResolvedPrimeImage {
  readonly data: string;
  readonly mimeType: ImageMediaType;
}

/** Strongly typed image boundary used by the Prime/DSH context converter. */
export interface DshImageAttachmentGateway {
  admitPrimeImages(images: readonly PrimeInlineImage[]): Promise<readonly ImageAttachmentRef[]>;
  resolveDshImage(attachment: ImageAttachmentRef, signal?: AbortSignal): Promise<ResolvedPrimeImage>;
}

const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

function imageMediaType(value: string): ImageMediaType {
  const supported = IMAGE_MEDIA_TYPES.find((candidate) => candidate === value);
  if (!supported) throw new AttachmentError(`Image type ${value} is not accepted by DSH.`, "UNSUPPORTED_IMAGE_TYPE");
  return supported;
}


/** Ordered Prime user-turn content accepted by the pooled provider. */
export type PrimeTurnContent =
  | { readonly type: "text"; readonly text: string }
  | PrimeTurnImage;

/**
 * Admit every inline image through DSH's authoritative batch gate, then build
 * immutable-reference content blocks without changing the caller's ordering.
 */
export async function admitPrimeTurnContent(
  attachments: AttachmentStore,
  content: readonly PrimeTurnContent[],
): Promise<ContentBlock[]> {
  const images = content.filter((block): block is PrimeTurnImage => block.type === "image");
  const admitted = await admitEncodedImages(attachments, images.map((image) => ({
    data: image.data,
    mediaType: imageMediaType(image.mimeType),
    ...(image.name === undefined ? {} : { name: image.name }),
  })));
  let imageIndex = 0;
  return content.map((block): ContentBlock => block.type === "text"
    ? { type: "text", text: block.text }
    : { type: "image", attachment: admitted[imageIndex++] });
}

/**
 * Real DSH-backed attachment admission and resolution.
 *
 * Admission uses DSH's public canonical-base64 batch API and the local durable,
 * content-addressed store. Resolution re-reads through the store, which verifies
 * the durable reference and digest before exposing bytes to Prime.
 */
export class LocalDshImageAttachments implements DshImageAttachmentGateway {
  readonly context: Context;
  readonly store: LocalAttachmentStore;

  constructor(config: LocalAttachmentConfig = {}) {
    this.context = new Context();
    this.store = new LocalAttachmentStore(this.context, config);
  }

  async admitPrimeImages(images: readonly PrimeInlineImage[]): Promise<readonly ImageAttachmentRef[]> {
    const encoded: EncodedImageAttachment[] = images.map((image) => ({
      data: image.data,
      mediaType: imageMediaType(image.mimeType),
      ...(image.name === undefined ? {} : { name: image.name }),
    }));
    return admitEncodedImages(this.store, encoded);
  }

  async resolveDshImage(attachment: ImageAttachmentRef, signal?: AbortSignal): Promise<ResolvedPrimeImage> {
    const stored = await this.store.readImage(attachment, signal);
    return { data: Buffer.from(stored.data).toString("base64"), mimeType: stored.ref.mediaType };
  }
}
