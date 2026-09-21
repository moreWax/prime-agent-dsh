# Projection and provider-cache architecture

Prime is the only owner of model requests, active context, canonical session JSONL, and compaction. DSH never plans, requests, summarizes, prunes, or commits compaction. It does not interpret history changes as compaction events.

DSH observes Prime lifecycle events and indexes the resulting JSONL into a rebuildable, reference-only projection. The `session_compact` hook is passive: after Prime has replaced history, it triggers the same resynchronization used by other lifecycle events.

## Publication diagnostics

A publication reports only structural facts:

- source mode: `append`, `rebuild`, or `noop`;
- source entries reused, new, and reindexed;
- effective entries reused, new, and reindexed;
- a generic effective rebuild reason.

These facts do not assign semantic meaning to a history replacement. Prime entries such as `compaction` and `compactionSummary` remain ordinary canonical data that converters and RLM inheritance may read.

## Provider cache metrics

Provider-reported input, cache-read, and cache-write token counts are collected as a generic request series. Aggregate counts, efficiency, and percentiles describe only what the provider reported. DSH does not create cache epochs, mark compaction boundaries, or classify first-after-compaction and summary requests.

## Safety

DSH does not edit Prime JSONL or active request context. Derived state can be deleted and rebuilt from Prime's canonical files. Publication and telemetry failures fail open and leave Prime inference unchanged.
