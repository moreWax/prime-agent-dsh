export const PROTOCOL = "dsh-context/1" as const;
export type SimpleMessage = { role: "user" | "assistant"; content: string; source?: string; provider?: string; model?: string };
export type Request = { version: typeof PROTOCOL; id: string | number; method: string; params?: unknown };
export type Success = { version: typeof PROTOCOL; id: string | number; ok: true; result: unknown };
export type Failure = { version: typeof PROTOCOL; id: string | number | null; ok: false; error: { code: string; message: string; data?: unknown } };
