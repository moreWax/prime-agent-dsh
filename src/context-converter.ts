import { freezeMessage, type ContentBlock, type Message } from "@deepseek-ai/dsh-llm";
import { MessageId, ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";

/** Prime's model-context message shape. Kept structural so this bridge does not depend on Prime internals. */
export type PrimeMessage = Record<string, unknown> & { role: string };
export type PrimeEnvelope = { id?: string; parentId?: string | null; timestamp?: string; message: PrimeMessage };
export type ConversionCapability = "prime-image-admission" | "dsh-image-resolution";
export class ConversionCapabilityError extends Error {
  readonly code = "CAPABILITY_UNAVAILABLE";
  constructor(readonly capability: ConversionCapability, message: string, readonly data?: unknown) { super(message); }
}
export interface ConverterCapabilities {
  /** Admit inline Prime bytes into DSH's durable attachment store. */
  admitImage?: (image: { data: string; mimeType: string; name?: string }) => ImageAttachmentRef;
  /** Resolve a DSH durable reference back to inline Prime bytes. */
  resolveImage?: (attachment: ImageAttachmentRef) => { data: string; mimeType: string };
}
export interface AsyncConverterCapabilities {
  /** Admit inline Prime bytes before constructing the immutable DSH message. */
  admitImages?: (images: readonly { data: string; mimeType: string; name?: string }[]) => Promise<readonly ImageAttachmentRef[]>;
  /** Resolve and verify DSH bytes before constructing a Prime message. */
  resolveImage?: (attachment: ImageAttachmentRef) => Promise<{ data: string; mimeType: string }>;
}

type PrimeMeta = { role: string; envelope?: Omit<PrimeEnvelope, "message">; fields: Record<string, unknown> };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const string = (v: unknown, what: string): string => { if (typeof v !== "string") throw new TypeError(`${what} must be a string`); return v; };
function parts(content: unknown): Record<string, unknown>[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) throw new TypeError("message content must be a string or array");
  return content.map((p, i) => { if (!object(p) || typeof p.type !== "string") throw new TypeError(`invalid content block at index ${i}`); return p; });
}
function toDshBlocks(content: unknown, caps: ConverterCapabilities, assistant: boolean): ContentBlock[] {
  return parts(content).map((p): ContentBlock => {
    switch (p.type) {
      case "text": return { type: "text", text: string(p.text, "text") };
      case "thinking": if (!assistant) throw new TypeError("thinking is only valid in assistant content"); return { type: "reasoning", text: string(p.thinking, "thinking") };
      case "toolCall": {
        if (!assistant) throw new TypeError("toolCall is only valid in assistant content");
        const args = p.arguments;
        return { type: "tool-call", id: ToolCallId(string(p.id, "toolCall.id")), name: string(p.name, "toolCall.name"), arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) };
      }
      case "image": {
        if (!caps.admitImage) throw new ConversionCapabilityError("prime-image-admission", "inline Prime images require an attachment admission capability", { mimeType: p.mimeType });
        return { type: "image", attachment: caps.admitImage({ data: string(p.data, "image.data"), mimeType: string(p.mimeType, "image.mimeType"), ...(typeof p.name === "string" ? { name: p.name } : {}) }) };
      }
      default: throw new ConversionCapabilityError("prime-image-admission", `unsupported Prime content block: ${String(p.type)}`, { block: p });
    }
  });
}
function split(input: PrimeMessage | PrimeEnvelope): { message: PrimeMessage; envelope?: Omit<PrimeEnvelope, "message"> } {
  if (object(input) && object(input.message)) { const { message, ...envelope } = input; return { message: message as PrimeMessage, envelope: envelope as Omit<PrimeEnvelope, "message"> }; }
  return { message: input as PrimeMessage };
}
/** Lossless Prime -> DSH projection. Prime-only fields ride source.prime for the reverse projection. */
export function primeToDsh(input: PrimeMessage | PrimeEnvelope, caps: ConverterCapabilities = {}, idOverride?: string): Message {
  const { message: p, envelope } = split(input); const role = string(p.role, "role");
  const fields: Record<string, unknown> = {}; for (const [k, v] of Object.entries(p)) if (k !== "role" && k !== "content") fields[k] = v;
  const meta: PrimeMeta = { role, ...(envelope ? { envelope } : {}), fields };
  let content: ContentBlock[]; let dshRole: "user" | "assistant"; let source: Message["source"] & { prime: PrimeMeta };
  if (role === "user") { content = toDshBlocks(p.content, caps, false); dshRole = "user"; source = { kind: "user", prime: meta }; }
  else if (role === "assistant") { content = toDshBlocks(p.content, caps, true); dshRole = "assistant"; source = { kind: "model", provider: typeof p.provider === "string" ? p.provider : "external", model: typeof p.model === "string" ? p.model : "unknown", ...(p.replayState === undefined ? {} : { replayState: p.replayState }), prime: meta }; }
  else if (role === "toolResult") {
    const callId = ToolCallId(string(p.toolCallId, "toolCallId"));
    content = [{ type: "tool-result", toolCallId: callId, content: toDshBlocks(p.content, caps, false), isError: p.isError === true }]; dshRole = "user"; source = { kind: "tool", callId, prime: meta };
  } else if (["bashExecution", "custom", "branchSummary", "compactionSummary"].includes(role)) {
    const text = role === "bashExecution" ? `${typeof p.command === "string" ? p.command : ""}
${typeof p.output === "string" ? p.output : ""}` : typeof p.summary === "string" ? p.summary : "";
    content = role === "custom" ? toDshBlocks(p.content, caps, false) : [{ type: "text", text }]; dshRole = "user"; source = role.includes("Summary")
      ? { kind: "plugin", plugin: `prime:${role}`, form: "recall", prime: meta }
      : { kind: "plugin", plugin: `prime:${role}`, form: "notice", summary: role, prime: meta };
  } else throw new TypeError(`unsupported Prime role: ${role}`);
  const id = idOverride ?? (typeof envelope?.id === "string" ? envelope.id : typeof p.id === "string" ? p.id : crypto.randomUUID());
  return freezeMessage({ id: MessageId(id), role: dshRole, content, source });
}
function fromDshBlocks(content: readonly ContentBlock[], caps: ConverterCapabilities): Record<string, unknown>[] {
  return content.flatMap((b): Record<string, unknown>[] => {
    switch (b.type) {
      case "text": return [{ type: "text", text: b.text }];
      case "reasoning": return [{ type: "thinking", thinking: b.text }];
      case "tool-call": { let args: unknown; try { args = JSON.parse(b.arguments); } catch { args = b.arguments; } return [{ type: "toolCall", id: b.id, name: b.name, arguments: args }]; }
      case "image": { if (!caps.resolveImage) throw new ConversionCapabilityError("dsh-image-resolution", "DSH image references require an attachment resolution capability", { attachment: b.attachment }); const x = caps.resolveImage(b.attachment); return [{ type: "image", data: x.data, mimeType: x.mimeType, ...(b.attachment.name ? { name: b.attachment.name } : {}) }]; }
      case "tool-result": return fromDshBlocks(b.content, caps);
      default: throw new TypeError(`unsupported DSH content block: ${String((b as unknown as { type?: unknown }).type)}`);
    }
  });
}
/** Lossless DSH -> Prime projection for messages produced by this bridge; canonical mapping otherwise. */
export function dshToPrime(message: Message, caps: ConverterCapabilities = {}): PrimeMessage | PrimeEnvelope {
  const sourceWithPrime = message.source as Message["source"] & { prime?: unknown };
  const meta = object(sourceWithPrime.prime) ? sourceWithPrime.prime as PrimeMeta : undefined;
  if (meta) {
    const restored: PrimeMessage = { role: meta.role, ...meta.fields };
    if (["user", "assistant", "toolResult", "custom"].includes(meta.role)) restored.content = fromDshBlocks(message.content[0]?.type === "tool-result" ? message.content[0].content : message.content, caps);
    if (meta.role === "toolResult") { const block = message.content[0] as Extract<ContentBlock, { type: "tool-result" }>; restored.toolCallId = block.toolCallId; restored.isError = block.isError === true; }
    return meta.envelope ? { ...meta.envelope, message: restored } : restored;
  }
  if (message.role === "assistant") return { role: "assistant", content: fromDshBlocks(message.content, caps), provider: message.source.kind === "model" ? message.source.provider : "external", model: message.source.kind === "model" ? message.source.model : "unknown" };
  if (message.source.kind === "tool") { const b = message.content[0]; if (b?.type !== "tool-result") throw new TypeError("tool-source message lacks tool-result block"); return { role: "toolResult", toolCallId: b.toolCallId, toolName: "unknown", content: fromDshBlocks(b.content, caps), isError: b.isError === true }; }
  return { role: "user", content: fromDshBlocks(message.content, caps) };
}


/** Async Prime -> DSH projection for attachment stores with durable I/O. */
export async function primeToDshAsync(input: PrimeMessage | PrimeEnvelope, caps: AsyncConverterCapabilities = {}, idOverride?: string): Promise<Message> {
  const { message, envelope } = split(input);
  const images = parts(message.content).filter((part) => part.type === "image");
  if (images.length > 0 && !caps.admitImages) throw new ConversionCapabilityError("prime-image-admission", "inline Prime images require an attachment admission capability");
  const uploads = images.map((part) => ({
    data: string(part.data, "image.data"),
    mimeType: string(part.mimeType, "image.mimeType"),
    ...(typeof part.name === "string" ? { name: part.name } : {}),
  }));
  const admitted = caps.admitImages ? await caps.admitImages(uploads) : [];
  let next = 0;
  const syncCaps: ConverterCapabilities = { admitImage: () => {
    const attachment = admitted[next++];
    if (!attachment) throw new Error("admitted image reference is missing");
    return attachment;
  } };
  return primeToDsh(envelope ? { ...envelope, message } : message, syncCaps, idOverride);
}

async function resolveDshBlocks(content: readonly ContentBlock[], caps: AsyncConverterCapabilities): Promise<ConverterCapabilities> {
  const resolved = new Map<ImageAttachmentRef, { data: string; mimeType: string }>();
  const visit = async (blocks: readonly ContentBlock[]): Promise<void> => {
    for (const block of blocks) {
      if (block.type === "image") {
        if (!caps.resolveImage) throw new ConversionCapabilityError("dsh-image-resolution", "DSH image references require an attachment resolution capability", { attachment: block.attachment });
        resolved.set(block.attachment, await caps.resolveImage(block.attachment));
      } else if (block.type === "tool-result") await visit(block.content);
    }
  };
  await visit(content);
  return { resolveImage: (attachment) => {
    const image = resolved.get(attachment);
    if (!image) throw new Error("resolved image bytes are missing");
    return image;
  } };
}

/** Async DSH -> Prime projection that verifies and resolves durable image references. */
export async function dshToPrimeAsync(message: Message, caps: AsyncConverterCapabilities = {}): Promise<PrimeMessage | PrimeEnvelope> {
  return dshToPrime(message, await resolveDshBlocks(message.content, caps));
}
