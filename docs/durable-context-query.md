# Durable context query adapter

`src/durable-context-query.ts` is a read-only query layer for
`DurableContextStore` commits. Prime's JSONL remains the canonical session. The
publication store and every search view are derived and can be deleted and
rebuilt from Prime through the publisher.

The adapter intentionally has no new runtime dependency. Version
`0.1.6-alpha.2` of `@deepseek-ai/dsh-session-query` queries DSH Session event
logs through a Cordis service, while these records are Prime-derived context
checkpoints with content-addressed commit provenance. Its SQLite provider has
the same Session-event schema and therefore is not a safe direct index for this
format. If a future persistent FTS index is added, it should be an optional
cache keyed by `bindingDigest`, `commitDigest`, `objectDigest`, entry digest,
and extractor version. It must never become query or recovery authority.

## Guarantees

- The constructor verifies `BINDING` against both the session ID and canonical
  Prime file path. A store cannot be opened through another session binding.
- Every head, commit, object, effective-array digest, and effective-entry digest
  is checked before use. A bad checkpoint is skipped and counted.
- Literal matching is case-insensitive and whitespace-flexible. Regex patterns
  and flags are bounded. Full-text ranking uses deterministic BM25-style scores
  and stable tie breaks.
- Cursors bind the complete query and a maximum generation. Later publications
  do not change pages already in progress. Cursors remain usable after process
  restart because their authority is immutable commits, not process memory.
- Checkpoint count, query bytes, scanned entries, page size, and cursor bytes
  have explicit bounds.
- Effective hits return exact JSON bodies. Source hits use the store's bounded
  compatibility rendering and are marked `exactBody: false`; their provenance
  still carries the exact source-entry digest.
