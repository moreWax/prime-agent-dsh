# Single-window, cache-stable context architecture

## Goal

Use DeepSeek Harness as a derived append-only context and retrieval layer while Prime Agent remains the only model loop, tool loop, transcript authority, and provider-visible context window.

This follows the useful Reasonix pattern without importing Reasonix's agent loop:

1. Keep complete history in an append-only authoritative record.
2. Derive exactly one ordered model-visible working set.
3. Append new turns without changing prior request bytes during a cache epoch.
4. Record compaction or pruning as a new durable projection decision; never delete the original evidence.
5. Treat search indexes and projection checkpoints as rebuildable caches.

## Terms that must remain separate

- **Canonical history:** Prime JSONL. It is authoritative and is never edited by this package.
- **DSH derived history:** immutable commits, objects, spill records, and indexes derived from a specific Prime branch cut.
- **Model window:** the single `AgentMessage[]` that Prime sends through its selected provider for one AgentSession.
- **Provider prompt/KV cache:** provider-side reuse based on the exact request prefix or Prime/pi-ai's stable session cache key. DSH does not store provider KV tensors.
- **Projection cache:** host-side checkpoints that avoid refolding an event log. This does not itself improve provider cache hits.

## Single-window invariants

1. The production package never registers a provider, model-facing tool, DSH AgentLoop, or second ordinary inference path.
2. The normal `context` hook is non-mutating. Any future active selection must return one validated subset of the original Prime messages, not a second DSH conversation or a DSH-to-Prime reconstruction.
3. One Prime AgentSession has one provider-visible window. Root and RLM child AgentSessions have separate windows by Prime design; inheritance is one bounded tail admission into the child's single window.
4. Retrieval enters the same window only as a normal, bounded Prime-recorded result. Search never starts an auxiliary conversational context.
5. Auxiliary summarization is not a second authority, but it is a separate provider request and must be identified and measured as such.

## Cache-epoch invariants

Within an epoch, preserve the longest possible byte-identical prefix:

- keep provider, model, reasoning controls, system prompt bytes, tool schemas, and tool order stable;
- keep prior messages in exact chronological order and append new messages at the tail;
- do not inject timestamps, counters, pressure reports, current paths, or query-dependent retrieval near the front;
- admit a DSH evidence capsule only when its content changes, append it at the tail, and never regenerate an earlier capsule;
- keep Prime's stable session ID unchanged so supported pi-ai providers retain their cache key/session affinity.

Start a new epoch only for a real boundary:

- provider/model or request-envelope change;
- system prompt or tool-schema change;
- branch/fork rewrite;
- explicit context projection replacement;
- durable compaction or pruning that changes an earlier token.

The first request after a boundary is cold or partially cold. Report it separately from steady-state cache efficiency.

## Compaction contract

DSH compaction-basic obtains high reuse by summarizing with the exact existing warm prefix: current system message, current tools, selected history in original order, and one trailing compaction instruction. The committed replacement then begins a new main-request epoch.

Prime's current stock compactor instead uses a distinct summary system prompt, serializes history into one user message, and disables cache retention. Therefore this package defaults to `shadow` compaction. `active` remains explicit opt-in until an integrated implementation can:

1. replay the exact Prime provider-visible prefix and tool envelope;
2. use the same provider/model/session identity and keep cache retention enabled;
3. preserve Prime's balanced durable cut and commit through `session_before_compact`;
4. revalidate source provenance immediately before commit;
5. record auxiliary-request and first-post-replacement cache metrics separately.

## Durable append-only target

The current durable store publishes immutable commits and content-addressed objects, but each object contains the full effective message array. It is logically append-only yet not storage-efficient for long sessions and can hit the object-size ceiling.

The next storage version must use:

- per-entry or chunked content-addressed source and effective records;
- a commit DAG containing ordered references and append/rebuild/projection metadata;
- immutable projection-replacement decisions rather than destructive rewrites;
- a small validated head/manifest used only as a hint;
- one shared validator for TypeScript query, recovery, and Python readers;
- spill reachability derived from all valid heads;
- explicit durability barriers after committed assistant messages, before compaction, and at shutdown.

Prime JSONL remains the recovery authority until this version proves exact source reconstruction. Documentation must not claim that the current full-snapshot sidecar can independently recreate all canonical history.

## Cache measurement

Use provider-reported disjoint counters when available:

```text
steady_state_hit_rate = cacheRead / (uncachedInput + cacheRead)
```

Report cache writes separately. Never call a JSON common-prefix hash a cache hit. Track:

- epoch and reset reason;
- exact provider/model and stable Prime session identity;
- first request after reset versus steady-state requests;
- provider-reported uncached input, cache read, cache write, and output;
- request payload prefix diagnostics as non-authoritative evidence.

A 99% rate is a workload/provider outcome, not a package guarantee. The release gate is a measured improvement or non-regression on supported providers with stable workloads.

## Rollout

1. Observation-only baseline and provider usage reconciliation.
2. Shadow cache-epoch classification and reset-reason diagnostics.
3. Chunked append-only durable store with unified validation.
4. Cache-friendly auxiliary compaction request in shadow evaluation.
5. Opt-in active compaction after replay, recovery, cache, and provenance gates pass.
6. Any Jev selection remains shadow-only until it can preserve stable epochs; query-dependent per-turn reshuffling is prohibited.
