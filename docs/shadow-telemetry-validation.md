# Shadow telemetry validation

Staging implementation observes Prime `context` and `before_provider_request` events without returning replacements or mutating event values.

## Data retained

- SHA-256 fingerprint of canonical, credential-redacted payload
- byte size and previous-payload byte size
- byte-level longest common prefix and ratio
- request number, timestamp, stage, session ID, branch leaf ID, and change classification
- bounded in-memory trace (128 entries); no payload or message content

## Commands

- `/dsh-context-status` — current branch status
- `/dsh-context-trace [count]` — bounded recent trace
- `/dsh-context-trace clear` — clear current session trace

## Validation

`npm run check` passes TypeScript typechecking and 12 tests. Tests cover canonical fingerprints, credential redaction, UTF-8 byte LCP, append/rewrite classification, branch/session isolation, bounded traces, no payload mutation/content retention, and fail-open cyclic-payload handling.
