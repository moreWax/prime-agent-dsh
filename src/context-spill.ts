import { Buffer } from "node:buffer";
import type { FileAttachmentRef } from "@deepseek-ai/dsh-attachment";
import type { DurableFileAttachments } from "./durable-file-attachments.js";

export const CONTEXT_SPILL_VERSION = "prime-agent-dsh/context-spill-v1" as const;

export interface ContextSpillLocator {
  readonly version: typeof CONTEXT_SPILL_VERSION;
  readonly encoding: "utf-8";
  readonly attachment: FileAttachmentRef;
}
export interface InlineContextText { readonly text: string; readonly spilled: false }
export interface SpilledContextText {
  readonly text: string;
  readonly spilled: true;
  readonly locator: ContextSpillLocator;
  readonly originalBytes: number;
}
export type ContextText = InlineContextText | SpilledContextText;
export interface SpillOptions {
  /** Spill only when exact UTF-8 size is greater than this value. */
  readonly thresholdBytes?: number;
  /** Maximum UTF-8 bytes in the returned preview, including its marker. */
  readonly previewBytes?: number;
  readonly name?: string;
}

/**
 * Persist oversized context without making persistence a new failure mode.
 * Any write/quota error returns the exact original inline string.
 */
export async function spillContextText(
  attachments: Pick<DurableFileAttachments, "save">,
  value: string,
  options: SpillOptions = {},
): Promise<ContextText> {
  const threshold = limit(options.thresholdBytes ?? 32 * 1024, "thresholdBytes");
  const previewBytes = limit(options.previewBytes ?? 4 * 1024, "previewBytes");
  if (!wellFormed(value)) return { text: value, spilled: false };
  const data = Buffer.from(value, "utf8");
  if (data.byteLength <= threshold) return { text: value, spilled: false };
  try {
    const attachment = await attachments.save(data, options.name ?? "context.txt");
    return {
      text: utf8Preview(data, previewBytes),
      spilled: true,
      locator: { version: CONTEXT_SPILL_VERSION, encoding: "utf-8", attachment },
      originalBytes: data.byteLength,
    };
  } catch {
    return { text: value, spilled: false };
  }
}


export interface TextToolResult {
  readonly content: string;
  readonly [key: string]: unknown;
}
export type SpilledToolResult<T extends TextToolResult> = T & { readonly contextSpill?: ContextSpillLocator };

/** Spill the string payload of a tool result while preserving all other fields. */
export async function spillToolResult<T extends TextToolResult>(
  attachments: Pick<DurableFileAttachments, "save">,
  result: T,
  options: SpillOptions = {},
): Promise<SpilledToolResult<T>> {
  const spilled = await spillContextText(attachments, result.content, {
    ...options,
    name: options.name ?? "tool-result.txt",
  });
  if (!spilled.spilled) return result;
  return { ...result, content: spilled.text, contextSpill: spilled.locator };
}

/** Resolve a locator after the attachment backend verifies its size and digest. */
export async function resolveContextSpill(
  attachments: Pick<DurableFileAttachments, "read">,
  locator: ContextSpillLocator,
  signal?: AbortSignal,
): Promise<string> {
  if (locator.version !== CONTEXT_SPILL_VERSION || locator.encoding !== "utf-8") throw new Error("invalid context spill locator");
  const bytes = await attachments.read(locator.attachment, signal);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** UTF-8-safe prefix whose encoded size never exceeds `maximum`. */
export function utf8Preview(data: Uint8Array, maximum: number): string {
  limit(maximum, "maximum");
  if (data.byteLength <= maximum) return new TextDecoder("utf-8", { fatal: true }).decode(data);
  const marker = `\n[… ${data.byteLength} UTF-8 bytes total; full content at locator …]`;
  const markerBytes = Buffer.byteLength(marker);
  if (markerBytes > maximum) return truncateUtf8(Buffer.from(marker), maximum);
  return truncateUtf8(data, maximum - markerBytes) + marker;
}

function truncateUtf8(data: Uint8Array, maximum: number): string {
  let end = Math.min(maximum, data.byteLength);
  while (end > 0 && (data[end] & 0xc0) === 0x80) end--;
  return new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, end));
}
function limit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function wellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) { const code = value.charCodeAt(i); if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; } else if (code >= 0xdc00 && code <= 0xdfff) return false; } return true;
}
