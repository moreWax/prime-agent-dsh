# DSH inference-context service — Phase 0

A deliberately small, **non-agent-loop** sidecar that accepts an authoritative transcript snapshot and projects the canonical model message context. It uses the public `@deepseek-ai/dsh-session` and `@deepseek-ai/dsh-llm` packages at `0.1.2-alpha.5` (and Cordis `4.0.2`).

## Run

```sh
npm ci
npm test
node dist/src/cli.js --stdio
# or: node dist/src/cli.js --socket /tmp/dsh-context.sock
```

Transport is newline-delimited JSON (one request and one response per line). Every request has `version: "dsh-context/1"`, a string/number `id`, `method`, and optional `params`. Responses echo version/id and contain either `{ok:true,result}` or `{ok:false,error:{code,message,data?}}`.

## Methods

* `initialize`: must be first, no params. Returns implementation and capability negotiation.
* `session/sync`: `{sessionId,messages,expectedRevision?}`. Atomically replaces the context from a complete snapshot. A message is `{role:"user"|"assistant",content:string,source?,provider?,model?}`. `expectedRevision` provides optimistic concurrency.
* `project`: `{sessionId,from?,limit?}`. Returns DSH's `Session.deriveMessages()` projection, paginated.
* `status`: health/session counters.
* `shutdown`: acknowledges and closes the transport after the response is scheduled.

Example:
```jsonl
{"version":"dsh-context/1","id":1,"method":"initialize"}
{"version":"dsh-context/1","id":2,"method":"session/sync","params":{"sessionId":"demo","messages":[{"role":"user","content":"hello"}]}}
{"version":"dsh-context/1","id":3,"method":"project","params":{"sessionId":"demo"}}
```

## Scope / constraints

This is an in-memory Phase 0 boundary, not persistence and not an agent. It never invokes an LLM or tool and does not load `dsh-agent-loop`. Snapshot sync is intentional: it gives callers an idempotent authoritative representation and permits atomic validation before replacing state. Each sync constructs a DSH `Session`, appends surface events with DSH message constructors, and uses `deriveMessages()` for projection. Process restart loses sessions. Unix socket mode supports one or more connections, but `shutdown` closes the listener; clients should serialize mutations per session or use `expectedRevision`.
