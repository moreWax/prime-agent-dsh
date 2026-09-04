import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ShadowContextTelemetry, type ShadowLocation, type ShadowTraceEntry } from "../src/shadow-telemetry.js";
import { ContextService } from "../src/dsh-context-service.js";
import { PROTOCOL } from "../src/context-protocol.js";
import { primeToDsh, dshToPrime } from "../src/context-converter.js";
import { stableJson } from "../src/prefix-metrics.js";

function location(ctx: ExtensionContext): ShadowLocation {
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    branchId: ctx.sessionManager.getLeafId() ?? "root",
  };
}
function metric(entry: ShadowTraceEntry | undefined): string {
  if (!entry) return "none";
  return `#${entry.request} ${entry.bytes}B sha256:${entry.digest.slice(0, 12)} lcp=${entry.commonPrefixBytes}B (${(entry.prefixRatio * 100).toFixed(1)}%) ${entry.reason}`;
}

/** Register passive telemetry. Handlers intentionally return nothing. */
export function registerShadowContextTelemetry(pi: ExtensionAPI): ShadowContextTelemetry {
  const telemetry = new ShadowContextTelemetry();
  const dsh = new ContextService();
  dsh.handle({ version: PROTOCOL, id: 1, method: "initialize" });
  let dshSyncs = 0, dshSkips = 0, dshErrors = 0, dshAppends = 0, dshNoops = 0, dshRebuilds = 0, requestId = 1;
  const revisions = new Map<string, number>();
  pi.on("context", (event, ctx) => {
    telemetry.observe("context", event.messages, location(ctx));
    try {
      const messages = event.messages.map((message, index) => primeToDsh(message as any, {}, `prime-${createHash("sha256").update(`${index}:`).update(stableJson(message)).digest("hex").slice(0, 32)}`));
      const here = location(ctx); const sessionId = here.sessionId;
      const response = dsh.handle({ version: PROTOCOL, id: ++requestId, method: "session/sync-canonical",
        params: { sessionId, messages, expectedRevision: revisions.get(sessionId) ?? 0 } }) as any;
      if (!response.ok) { dshErrors++; return; }
      const projection = dsh.handle({ version: PROTOCOL, id: ++requestId, method: "project", params: { sessionId } }) as any;
      const roundTrip = projection.ok ? projection.result.messages.map((message: any) => dshToPrime(message)) : undefined;
      if (!roundTrip || stableJson(roundTrip) !== stableJson(event.messages)) { dshSkips++; return; }
      revisions.set(sessionId, response.result.revision); dshSyncs++;
      if (response.result.mode === "append") dshAppends++; else if (response.result.mode === "noop") dshNoops++; else dshRebuilds++;
    } catch { dshErrors++; }
  });
  pi.on("before_provider_request", (event, ctx) => { telemetry.observe("before_provider_request", event.payload, location(ctx)); });

  pi.registerCommand("dsh-context-status", {
    description: "Show passive Prime context/provider prefix telemetry",
    handler: async (_args, ctx) => {
      const here = location(ctx); const status = telemetry.status(here.sessionId, here.branchId) ?? telemetry.status(here.sessionId);
      if (!status) { ctx.ui.notify(`DSH context shadow: no observations for session ${here.sessionId}`, "info"); return; }
      ctx.ui.notify(`DSH context shadow session=${status.sessionId} branch=${status.branchId} observations=${status.observations} errors=${status.errors}\ncontext ${metric(status.context)}\nprovider ${metric(status.provider)}
DSH mirror syncs=${dshSyncs} append=${dshAppends} noop=${dshNoops} rebuild=${dshRebuilds} skips=${dshSkips} errors=${dshErrors}`, status.errors || dshErrors ? "warning" : "info");
    },
  });
  pi.registerCommand("dsh-context-trace", {
    description: "Show or clear passive context fingerprint trace (/dsh-context-trace [count|clear])",
    handler: async (args, ctx) => {
      const here = location(ctx); const arg = args.trim().toLowerCase();
      if (arg === "clear") { telemetry.clear(here.sessionId); ctx.ui.notify("DSH context shadow trace cleared for this session", "info"); return; }
      const requested = arg ? Number.parseInt(arg, 10) : 10;
      const count = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 50) : 10;
      const entries = telemetry.traces(here.sessionId, count);
      const text = entries.length ? entries.map((entry) => `${entry.observedAt} branch=${entry.branchId} ${entry.stage} ${metric(entry)}`).join("\n") : "No context shadow trace observations.";
      ctx.ui.notify(text, "info");
    },
  });
  return telemetry;
}
