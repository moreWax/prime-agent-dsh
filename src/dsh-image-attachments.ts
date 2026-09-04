import { Buffer } from "node:buffer";
import { Context } from "@deepseek-ai/cordis";
import {
  AttachmentError,
  admitEncodedImages,
  type EncodedImageAttachment,
  type ImageAttachmentRef,
  type ImageMediaType,
} from "@deepseek-ai/dsh-attachment";
import { LocalAttachmentStore, type Config as LocalAttachmentConfig } from "@deepseek-ai/dsh-attachment-local";

/** Inline image block used by Prime's model context. */
export interface PrimeInlineImage {
  readonly data: string;
  readonly mimeType: string;
  readonly name?: string;
}

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
