# Prime Agent + DeepSeek Harness inference-context integration plan

## 1. Objective

Preserve Prime Agent's observable and operational behavior while applying every compatible DeepSeek Harness inference-time context capability beneath Prime's existing agent loop.

Prime remains authoritative for UI, session tree, agent loop, message queue, tools, IPython, skills, MCP, RLM, goals, approvals, model selection, provider authentication, retries, and response streaming. DSH never handles ordinary user input and never executes Prime tool calls. DSH owns an inference-facing mirror/projection used to make each Prime model request prefix-stable, reconstructable, compactable, and measurable.

A provider cache-hit percentage is an outcome to measure, not a hard-coded promise. Provider retention/eviction and gateway accounting remain external.

## 2. Non-goals

- No input interception or `[deepseek-harness]` replacement messages.
- No second user-facing conversation.
- No replacement of Prime's agent loop, tools, session JSONL, UI, or model picker.
- No direct mutation of either project's source or persistence formats.
- No claim that DSH's projection checkpoint cache is the provider's KV cache.
- No unlogged context rewrite: every model-visible replacement must be durable/reconstructable in Prime.

## 3. Target architecture

```text
Prime UI -> Prime AgentSession/loop -> Prime context assembly
                                      |
                                      v
                              inference-context bridge
                              - synchronize committed deltas
                              - stable request envelope
                              - DSH session/projection
                              - retention/pruning decision
                              - compaction decision
                              - prefix diagnostics
                                      |
                                      v
                         Prime ModelRegistry/provider stream
                                      |
                                      v
                         Prime tool execution / next step
```

The bridge has two halves:

1. **Prime package**: observes Prime lifecycle, translates committed Prime messages into a versioned neutral event protocol, asks the DSH service for a projection/decision, and leaves Prime's provider stream in control.
2. **DSH inference-context bundle**: a minimal Cordis application using public DSH session/projection/context components but no DSH agent loop, inbox, tool executor, or frontend.

## 4. Authority matrix

| Concern | Authority |
|---|---|
| User input and queues | Prime |
| Canonical conversation/session tree | Prime |
| Agent loop and tool dispatch | Prime |
| IPython/RLM/skills/MCP/goals | Prime |
| Model selection, auth, transport, retry | Prime |
| Provider response stream | Prime |
| Inference-facing context projection | DSH service |
| Request-series and prefix metadata | DSH service |
| Retention/pruning recommendation | DSH service |
| Durable compaction commit | Prime, using DSH recommendation |
| Actual cache accounting | Prime provider usage |

Prime JSONL is the canonical product history. The DSH mirror is derived and disposable; it can always be rebuilt from Prime.

## 5. Inference-time feature inventory

### Implement

- Append-only committed-message synchronization.
- Stable system-prompt and tool-schema envelope fingerprinting.
- Deterministic prompt/tool ordering verification.
- Explicit request-series boundaries on model, system, tool, or compatibility changes.
- Incremental derived-message projection.
- Deterministic oversized tool-result head/marker/tail pruning.
- Balanced compaction-region selection with a retained recent tail.
- Prefix-aligned auxiliary summarization planning.
- Replacement provenance/source-event links.
- Provider-native replay metadata preservation where Prime's provider supports it.
- Branch/fork projection identity and rebuild.
- Cache-eligibility and actual-cache observability.

### Do not import into this path

- DSH agent loop/inbox.
- DSH tool execution, subagents, jobs, goals, approval UI, or commands.
- DSH Web/ACP user-facing application.

Those remain available only through the explicit `deepseek_harness` delegation tool.

## 6. Phase 0: contract and feasibility spike

Before product integration, prove the minimal DSH service graph can run without `dsh-agent-loop`.

### Deliverables

- `packages/protocol`: versioned TypeScript schemas and conformance fixtures.
- `packages/dsh-inference-context`: static Cordis plugin/service.
- `profiles/inference-context/cordis.patch.yml`: minimal profile.
- In-memory tests that append translated events and call DSH `deriveMessages()`.

### DSH packages to evaluate

- `@deepseek-ai/dsh-session`
- `@deepseek-ai/dsh-session-projection`
- `@deepseek-ai/dsh-session-projection-cache` where useful for cold restore
- `@deepseek-ai/dsh-session-persistence` and JSONL backend
- `@deepseek-ai/dsh-compaction` contracts
- Pure helpers from `dsh-compaction-tool-result-pruner`
- `@deepseek-ai/dsh-token-meter` only if it can consume foreign model metadata without an Agent

### Exit criteria

1. Minimal process boots with no agent loop or tool executor.
2. A sequence of Prime fixture events projects to role/tool-pair-equivalent messages.
3. Restart restores exactly the same projection.
4. Append changes only the suffix.
5. Replacement has explicit provenance and changes only from its first replaced node.

If whole DSH plugins require the DSH Agent graph, implement a small external Cordis service using the public `Session` and pure leaf algorithms. Do not mount unused product bundles merely to satisfy injection dependencies.

## 7. Neutral bridge protocol

Use authenticated local JSON-RPC/JSONL over a Unix socket (named pipe on Windows), not stdout shared with another application.

### Core methods

```text
initialize
session/open
session/sync
session/project
session/plan-compaction
session/commit-replacement
session/fork
session/reset
session/status
shutdown
```

### `session/sync`

Carries only new committed facts plus expected prior sequence/digest:

```ts
interface SyncRequest {
  protocolVersion: 1;
  primeSessionId: string;
  branchId: string;
  expectedSeq: number;
  expectedDigest: string;
  events: PrimeContextEvent[];
}
```

Events include identified user/assistant/tool-result messages, compaction/branch replacements, model changes, and request-envelope snapshots. Tool-call IDs and tool-result pairing must be preserved. Payloads are schema-validated, size-bounded, and lossless JSON.

### `session/project`

Returns:

```ts
interface ProjectionResult {
  revision: number;
  sourceDigest: string;
  messages: NeutralMessage[];
  envelopeFingerprint: string;
  stablePrefix: { messages: number; bytes: number; ratio: number };
  seriesReason?: "initial" | "model" | "system" | "tools" | "compat" | "compaction" | "branch";
  replacements: ReplacementProvenance[];
}
```

No credentials, provider keys, environment variables, or arbitrary executable configuration cross this protocol.

## 8. Prime package integration

### Hooks

- `session_start`, `session_tree`: open/rebuild the derived DSH mirror for the active branch.
- `message_end`, `tool_result`, `turn_end`: synchronize committed suffixes after Prime has recorded them.
- `model_select`: end the current request series and record the route change.
- `before_agent_start`: capture/fingerprint the effective Prime system prompt.
- `context`: request/validate the DSH projection; initially observe-only, then gated replacement.
- `before_provider_request`: fingerprint final protocol payload and verify system/tool/message prefix stability; no mutation in initial releases.
- `after_provider_response`, `message_end`: collect response/cache usage.
- `session_before_compact`: request a DSH compaction plan and return a Prime `CompactionResult` only after validation.
- `session_compact`: synchronize the durable Prime replacement.
- `session_shutdown`: flush and detach.

### Fail-open policy

DSH optimization is non-authoritative. If the service is absent, slow, incompatible, or returns an invalid projection, Prime uses its original context unchanged and records a diagnostic. Never block normal Prime operation merely because optimization failed.

### Projection validation

Before accepting a DSH projection, verify:

- Same current branch/session revision.
- Same ordered roles and message IDs unless a declared replacement applies.
- Every tool result pairs with a retained tool call.
- No new tool call, instruction, image, or text was invented.
- All replacements cite existing source entries.
- No dropped recent messages.
- Output fits model capacity and reserves response space.

## 9. Compaction and pruning

### Stage A: diagnostics only

Compute candidate pruning and compaction but do not modify context. Compare against Prime's native decisions.

### Stage B: deterministic tool-result pruning

At compaction pressure, prune oversized text tool results using DSH's head + stable marker + tail rule. Preserve rich blocks and relative order. Persist via Prime's `session_before_compact` result; never rewrite only the transient `context` copy.

### Stage C: DSH-planned summary region

Use balanced boundaries and retain a recent tail. Prime still performs the authorized summarizer model call with its selected model/auth and commits the returned `CompactionEntry`. DSH chooses the region and stable prompt layout; it does not take over inference credentials.

### Stage D: prefix-aligned auxiliary call

Construct the summary request so its prefix matches the already-warm conversation request as far as the provider format permits. Validate provider-specific serialization with golden tests.

## 10. Request envelope and replay

Persist a hashable envelope per request series:

```ts
interface RequestEnvelope {
  model: { provider: string; id: string; api: string };
  systemDigest: string;
  toolsDigest: string;
  toolsOrder: string[];
  compatibilityDigest: string;
  contextRevision: number;
}
```

A change creates a new series rather than pretending the old prefix remains reusable. Preserve Prime/pi-ai response IDs and signatures already stored on assistant messages. Do not translate or discard provider replay metadata. DSH metadata is advisory unless the same Prime provider implementation can consume it.

## 11. Cache observability

Add `/dsh-context-status` and `/dsh-context-trace`.

Report separately:

1. **Eligibility**: longest byte-stable serialized prefix between adjacent requests.
2. **Actual usage**: Prime `usage.cacheRead` and `usage.cacheWrite`.
3. **Efficiency**: `cacheRead / (input + cacheRead)` where reported.
4. **Invalidation reason**: model/system/tools/branch/compaction/other.
5. **DSH mirror health**: revision, lag, rebuilds, validation failures.

Never label eligibility as a cache hit. Record per-call metrics and p50/p90/session aggregates. The release target is “no regression and maximal stable prefix,” not an unverified 99% claim.

## 12. Security

- Socket/pipe owner-only; random launch capability; peer-process validation where supported.
- No TCP listener by default.
- Strict schema, frame, message, total-context, and timeout limits.
- No provider credentials in DSH mirror, logs, patches, or diagnostics.
- Redact credential-shaped headers and extension-private details.
- Treat message/tool content as data, never configuration.
- DSH cannot choose binaries, profiles, cwd, model, tools, or permissions.
- Signed/pinned packages and compatibility lock for DSH developer-preview versions.

## 13. Compatibility and versioning

- Pin DSH packages atomically to one exact prerelease.
- Negotiate bridge protocol and capability flags on initialization.
- Maintain converters by Prime session format and pi-ai message vocabulary version.
- Store mirror schema version and source digest.
- On mismatch, discard/rebuild the mirror from Prime; never migrate Prime JSONL in place.
- Support Linux first, then macOS, then Windows named-pipe/process semantics.

## 14. Test plan

### Prime invariance

- Extension disabled and enabled emit identical Prime message/tool/session event sequences.
- Same tool arguments/results, IPython kernel state, RLM behavior, commands, queueing, cancellation, branching, and UI.
- Golden provider payloads are byte-identical before optimization pressure.

### Projection

- User/assistant/tool turns, parallel tools, images, custom messages, errors, aborted turns.
- Incremental sync equals full rebuild.
- Crash/restart, duplicate delivery, gaps, stale revisions, and branch forks.
- No orphan tool result or invented content.

### Prefix/cache

- Append-only turn preserves prior serialized prefix.
- Stable system and tool ordering across reloads.
- Every envelope mutation produces the expected series reason.
- Compaction invalidates only at the documented first replacement.
- Real provider tests assert cacheRead/cacheWrite when the provider reports them.

### Failure and security

- DSH down/slow/malformed returns original Prime context.
- Socket auth, oversized frames, malicious message content, symlink paths, secret redaction.
- Cancellation and process teardown have bounded completion.

## 15. Rollout

1. **v0.0.3 rollback baseline**: normal Prime behavior; explicit DSH delegation only.
2. **v0.0.4 telemetry preview**: DSH mirror + request fingerprints, no context mutation.
3. **v0.0.5 deterministic pruning preview**: opt-in durable pruning at compaction pressure.
4. **v0.0.6 DSH compaction planner**: opt-in balanced region and stable-tail policy.
5. **v0.0.7 provider-gated replay/prefix optimization**: only for adapters with passing golden tests.
6. **v0.1.0**: default-on only after invariance, recovery, and measurable cache tests pass.

Every phase includes a kill switch and automatic fail-open fallback.

## 16. Acceptance criteria

- No `[deepseek-harness]` messages during ordinary use.
- Prime UI, tools, loop, session tree, and outputs remain native.
- With no pressure, final provider payload is byte-identical to baseline.
- Derived DSH mirror can be deleted and rebuilt losslessly from Prime.
- No secret reaches DSH storage.
- Branch/resume/restart tests pass.
- Tool pairing remains valid under every replacement.
- Cache metrics distinguish eligibility from reported provider hits.
- A measured target is established on a provider that actually reports cache usage before claiming a percentage.

## 17. First implementation slice

Build only Phase 0 plus v0.0.4 telemetry:

1. Define neutral protocol and message/event converters.
2. Boot minimal DSH inference-context Cordis service.
3. Mirror and rebuild one Prime branch.
4. Derive and validate messages without changing Prime's context.
5. Fingerprint final provider payloads and calculate longest common prefix.
6. Add status/trace commands.
7. Run invariance and crash-recovery tests.

Do not enable pruning or compaction changes until this slice proves that normal Prime behavior is byte-for-byte unchanged.
