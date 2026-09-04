/** Capability inventory for the embedded `@deepseek-ai/dsh-base` profile.
 *
 * Status is deliberately evidence-based:
 * - verified: this bridge has an exercised integration path.
 * - loaded: dsh-base composes the service/tool, but this bridge has not verified it.
 * - degraded: it is composed, but a known bridge or configuration limit applies.
 * - unavailable: the embedded profile does not provide the claimed surface.
 */
export type DshCapabilityStatus = "verified" | "loaded" | "degraded" | "unavailable";
export type DshCapabilityId =
  | "images" | "questions" | "mcp" | "goals" | "plan" | "compaction"
  | "subagents" | "workflows" | "jobs" | "terminals" | "web" | "cache";

export interface DshCapabilityEvidence {
  kind: "base-row" | "bridge-path" | "known-limit" | "absence";
  source: string;
  detail: string;
}

export interface DshCapability {
  id: DshCapabilityId;
  label: string;
  status: DshCapabilityStatus;
  summary: string;
  evidence: readonly DshCapabilityEvidence[];
}

const row = (source: string, detail: string): DshCapabilityEvidence => ({ kind: "base-row", source, detail });
const path = (source: string, detail: string): DshCapabilityEvidence => ({ kind: "bridge-path", source, detail });
const limit = (source: string, detail: string): DshCapabilityEvidence => ({ kind: "known-limit", source, detail });
const absent = (detail: string): DshCapabilityEvidence => ({ kind: "absence", source: "@deepseek-ai/dsh-base/cordis.patch.yml", detail });

/**
 * The registry inventories the exact pinned base bundle, not the wider DSH
 * ecosystem. Keep "loaded" distinct from "verified": a patch row proves
 * composition, not successful use in the current process or credentials.
 */
export const DSH_CAPABILITIES = [
  { id: "images", label: "Images", status: "degraded", summary: "Base has durable attachments, but Prime image input is not forwarded by the provider bridge.", evidence: [row("attachment-local", "content-addressed attachment storage is composed"), limit("src/dsh-provider.ts", "image turns are replaced with a text notice; bytes are not forwarded")] },
  { id: "questions", label: "Questions", status: "degraded", summary: "Base has user questions; this bridge only answers permission prompts.", evidence: [row("user-questions", "question service is composed"), path("src/dsh-provider.ts", "permission requests can use approvalAnswerer"), limit("src/dsh-provider.ts", "no general ask-user-question presentation adapter is implemented")] },
  { id: "mcp", label: "MCP", status: "unavailable", summary: "No MCP client or tool row is composed by the embedded base profile.", evidence: [absent("no MCP row exists in the pinned base patch; installed ecosystem packages are not treated as loaded")] },
  { id: "goals", label: "Goals", status: "loaded", summary: "Goal state, round driver, slash command, and model tool are composed.", evidence: [row("goal / goal-round-driver / command-goal / tool-goal", "goal surfaces are present in the base patch")] },
  { id: "plan", label: "Plan", status: "loaded", summary: "Plan mode is composed; interactive approval has not been verified by this bridge.", evidence: [row("plan-mode", "plan instructions and exit-plan flow are composed")] },
  { id: "compaction", label: "Compaction", status: "loaded", summary: "Automatic, manual, and tool-result compaction are composed but not live-probed by this report.", evidence: [row("compaction-basic / command-compact / tool-result-pruner", "automatic, manual, and tool-result compaction are composed")] },
  { id: "subagents", label: "Subagents", status: "loaded", summary: "Spawn, fork, list, and control tools are composed.", evidence: [row("subagent* / tool-subagent*", "in-process spawn/fork and control surfaces are present")] },
  { id: "workflows", label: "Workflows", status: "loaded", summary: "Worker-thread workflow execution and its tool are composed.", evidence: [row("workflow-worker-thread / tool-workflow", "workflow provider and model tool are present")] },
  { id: "jobs", label: "Jobs", status: "loaded", summary: "Local background jobs and their model tool are composed.", evidence: [row("jobs / tool-jobs", "local jobs service and model tool are present")] },
  { id: "terminals", label: "Terminals", status: "unavailable", summary: "Base provides shell execution, not a persistent terminal service.", evidence: [absent("no terminal service/tool row exists; bash and pwsh tools are finite command execution")] },
  { id: "web", label: "Web", status: "degraded", summary: "Fetch is composed; search additionally requires a usable DeepSeek credential.", evidence: [row("web / web-fetch-http / web-search-deepseek / tool-web", "fetch and search surfaces are composed"), limit("web-search-deepseek", "search depends on DEEPSEEK_API_KEY or managed credentials and is not probed by this command")] },
  { id: "cache", label: "Cache", status: "loaded", summary: "A persisted session projection cache is composed; this is not a general response cache.", evidence: [row("session-projection-cache", "versioned session projection checkpoints are persisted"), limit("session-projection-cache", "scope is session projections, not model responses or arbitrary values")] },
] as const satisfies readonly DshCapability[];

export function dshCapabilityRegistry(): readonly DshCapability[] {
  return DSH_CAPABILITIES;
}

export function formatDshCapabilities(capabilities: readonly DshCapability[] = DSH_CAPABILITIES): string {
  const counts: Record<DshCapabilityStatus, number> = { verified: 0, loaded: 0, degraded: 0, unavailable: 0 };
  for (const capability of capabilities) counts[capability.status]++;
  const header = `DSH capabilities (pinned dsh-base): verified=${counts.verified}, loaded=${counts.loaded}, degraded=${counts.degraded}, unavailable=${counts.unavailable}`;
  return [header, ...capabilities.map((capability) => {
    const evidence = capability.evidence.map((item) => `${item.kind}:${item.source}`).join(", ");
    return `${capability.label}: ${capability.status} — ${capability.summary} [${evidence}]`;
  }), "Status reports composition and bridge evidence only; it does not probe credentials or external services."].join("\n");
}
