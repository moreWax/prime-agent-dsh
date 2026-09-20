---
name: dsh-context
description: Inspect the current Prime session through lazy DeepSeek Harness context objects. Use to search prior turns, read bounded transcript slices, inspect provider-reported cache usage, create immutable snapshots or private artifacts, deliberately admit selected context, and grant bounded parent context to an RLM descendant.
---

# DSH Context Objects

The extension mirrors Prime's canonical active branch into a rebuildable DSH projection before each model request. Prime remains the only model/tool loop and canonical session log. The Python module reads immutable private snapshots; it never edits either history.

```python
ctx = dsh_context.current()
ctx

ctx.entries(last=10)
ctx.search("authentication", limit=20)
ctx.metrics

selection = ctx.search("migration decision", limit=8)
print(ctx.inject(selection, label="Relevant migration decisions"))
```

## API

- `dsh_context.current()` returns the current session's `ContextHandle`.
- `ctx.snapshot(digest=None)` pins the current or named immutable snapshot.
- `ctx.entries(start=0, limit=20, last=None, role=None)` returns bounded Prime branch entries.
- `ctx.messages(start=0, limit=20, last=None, role=None)` returns bounded DSH-projected messages.
- `ctx.search(query, limit=20, regex=False, case_sensitive=False)` searches the complete retained entry range.
- `ctx.metrics` reports provider-supplied input, output, cache-read, cache-write, and total token aggregates. It does not infer cache hits.
- `ctx.artifact(value, label="context")` writes selected material to a private content-addressed Markdown file.
- `ctx.inject(value, label="Selected DSH context", max_bytes=65536)` returns bounded model-facing text. **Print or return this value from the IPython cell** so Prime records it as a durable tool result. `ctx.admit` is an alias.
- `grant = ctx.grant(value, label="Shared parent context")` creates a bounded, expiring read-only capability. Include `grant.instruction` in an RLM child's task.
- `dsh_context.open_grant(grant.uri)` opens a grant reachable from the current session directory or one of its ancestors.

## Parent-to-child context

```python
selection = ctx.search("authentication design", limit=12)
grant = ctx.grant(selection, label="Authentication evidence")
child = await rlm.spawn(
    "Review the authentication design. " + grant.instruction,
    name="auth-review",
)
```

The child can then call:

```python
evidence = dsh_context.open_grant("dsh-context-grant:...")
evidence.value
```

A grant contains only the selected bounded value, its source snapshot identity, and expiry. It does not grant parent tool authority or a live parent transcript.

## Rules

- Search and inspect before admitting context; do not copy the complete transcript into active context.
- Treat snapshots as read-only evidence at their recorded revision and branch leaf.
- A child sees its own session snapshot. A small untrusted evidence capsule is inherited automatically through stock Prime lifecycle hooks; use an explicit capability grant for larger selected parent context.
- Snapshot files and indexes are derived and rebuildable; Prime JSONL remains authoritative.
- Printing `ctx.inject(...)` is the supported durable-admission path on Prime 0.9.5. Arbitrary extension-defined Python host requests are not public in that release.
- Provider cache metrics are authoritative; context-object access itself does not imply a cache hit.
