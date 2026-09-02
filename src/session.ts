import { createHash } from "node:crypto";

export function dshSessionId(primeSessionId: string, branchLeafId?: string | null): string {
  const digest = createHash("sha256")
    .update("prime-agent-dsh:v1\0")
    .update(primeSessionId)
    .update("\0")
    .update(branchLeafId || "root")
    .digest("hex")
    .slice(0, 32);
  return `prime-${digest}`;
}
