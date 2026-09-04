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
  { id: "images", label: "Images", status: "verified", summary: "Prime raster image blocks are admitted through DSH attachment storage and forwarded in exact turn order.", evidence: [row("attachment-local", "content-addressed attachment storage is composed"), path("tests/live-provider.mjs", "live pooled route verifies ordered PNG admission at the native model boundary"), limit("src/dsh-image-attachments.ts", "supported input is PNG, JPEG, WebP, and GIF; generic files, audio, and video are excluded")] },
  { id: "questions", label: "Questions", status: "verified", summary: "The standard ask_user_question tool is mounted and agent-scoped questions are bridged to Prime dialogs.", evidence: [row("user-questions + dsh-tool-ask-user", "question service and standard agent tool are composed"), path("src/prime-user-questions.ts", "choice, custom, multiselect, and plan-review answers map to Prime UI"), path("tests/prime-user-questions.test.ts", "adapter and headless fail-closed behavior are exercised")] },
  { id: "mcp", label: "MCP", status: "unavailable", summary: "No MCP client or tool row is composed by the embedded base profile.", evidence: [absent("no MCP row exists in the pinned base patch; installed ecosystem packages are not treated as loaded")] },
  { id: "goals", label: "Goals", status: "verified", summary: "Goal state and tools are composed and persist across transparent turns.", evidence: [row("goal / goal-round-driver / command-goal / tool-goal", "goal surfaces are present in the base patch"), path("tests/live-provider.mjs", "create_goal and get_goal are exercised across same-session turns")] },
  { id: "plan", label: "Plan", status: "verified", summary: "Plan mode is composed and its structured review intent is bridged to Prime confirmation UI.", evidence: [row("plan-mode", "plan instructions and exit-plan flow are composed"), path("tests/prime-user-questions.test.ts", "plan-review detail and approval mapping are exercised"), limit("dsh-plan-mode", "plan mode guides the agent; it is not a hard tool-enforcement boundary")] },
  { id: "compaction", label: "Compaction", status: "verified", summary: "Automatic and manual compaction are composed; native tool-result pruning is live-probed under token pressure.", evidence: [row("compaction-basic / command-compact / tool-result-pruner", "automatic, manual, and tool-result compaction are composed"), path("tests/live-provider.mjs", "oversized internal bash output is pruned with the stock marker before the next model step")] },
  { id: "subagents", label: "Subagents", status: "verified", summary: "The embedded live probe completes a deterministic foreground spawn child; fork, list, and control are composed but not behaviorally claimed.", evidence: [row("subagent* / tool-subagent*", "in-process spawn/fork and control surfaces are present"), path("tests/live-provider.mjs", "a deterministic model tool call starts and collects a real in-process child")] },
  { id: "workflows", label: "Workflows", status: "verified", summary: "Worker-thread workflow execution is composed and live-probed with one deterministic child.", evidence: [row("workflow-worker-thread / tool-workflow", "workflow provider and model tool are present"), path("tests/live-provider.mjs", "a model-authored script runs in the real engine and collects one child")] },
  { id: "jobs", label: "Jobs", status: "verified", summary: "Local background jobs are composed and live-probed through start and bounded job_output collection.", evidence: [row("jobs / tool-jobs", "local jobs service and model tool are present"), path("tests/live-provider.mjs", "a one-shot child job is started and collected through the real registry tools")] },
  { id: "terminals", label: "Terminals", status: "unavailable", summary: "Base provides shell execution, not a persistent terminal service.", evidence: [absent("no terminal service/tool row exists; bash and pwsh tools are finite command execution")] },
  { id: "web", label: "Web", status: "degraded", summary: "Fetch is composed; search additionally requires a usable DeepSeek credential.", evidence: [row("web / web-fetch-http / web-search-deepseek / tool-web", "fetch and search surfaces are composed"), limit("web-search-deepseek", "search depends on DEEPSEEK_API_KEY or managed credentials and is not probed by this command")] },
  { id: "cache", label: "Cache", status: "verified", summary: "Cold restart restores persisted DSH sessions, and provider-reported cache reads are preserved across repeated-prefix turns.", evidence: [row("session-projection-cache", "versioned session projection checkpoints are persisted"), path("tests/live-provider.mjs", "separate-process resume, route isolation, stable prefix, and provider-returned cached-token accounting are exercised"), limit("session-projection-cache", "projection persistence and upstream model prompt caching are distinct mechanisms")] },
] as const satisfies readonly DshCapability[];

export interface DshOptionalCapabilityConfig {
  mcpServers?: readonly unknown[];
  persistentTerminal?: boolean;
}

export function dshCapabilityRegistry(config?: DshOptionalCapabilityConfig): readonly DshCapability[] {
  return DSH_CAPABILITIES.map((capability): DshCapability => {
    if (capability.id === "mcp" && (config?.mcpServers?.length ?? 0) > 0) return {
      ...capability,
      status: "loaded",
      summary: "Operator-declared or Prime settings.json-inherited MCP clients are mounted in the pooled Agent scope; runtime server behavior is not probed by this report.",
      evidence: [path("src/dsh-provider-host.ts", "validated operator-only servers mount with failOnStartupError"), limit("src/dsh-provider-config.ts", "no model-facing server manager; configuration changes isolate pool identity")],
    };
    if (capability.id === "terminals" && config?.persistentTerminal === true) return {
      ...capability,
      status: "loaded",
      summary: "The optional persistent Bash backend and model tool are mounted; runtime PTY behavior is not probed by this report.",
      evidence: [path("src/dsh-provider-host.ts", "terminal backend mounts per tree and persistent Bash tool per Agent"), limit("src/dsh-provider-config.ts", "operator opt-in; unsupported on Windows")],
    };
    return capability;
  });
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
