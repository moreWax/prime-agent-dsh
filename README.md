# prime-agent-dsh

A self-contained Prime Agent package that uses selected DeepSeek Harness context components without replacing Prime Agent's native model and tool loop.

> DeepSeek Harness `0.1.6-alpha.2` is a developer preview. This package pins compatible DSH and Cordis versions exactly.

## Architecture

Prime Agent is the sole authority for:

- model calls and response streaming;
- tools, IPython, skills, MCP, RLM children, and goals;
- session JSONL, branching, compaction commits, and lifecycle;
- model selection, authentication, approvals, and retries.

The package adds a fail-open DSH context sidecar to each Prime `AgentSession`. Every root session and RLM descendant receives an isolated scope. The sidecar derives a rebuildable DSH projection from Prime's active branch and writes immutable, content-addressed snapshots beneath that session's artifact directory. The same automatic lifecycle sync feeds durable query, spill and verified file/image attachment stores, token-pressure and provider-cache series, and Prime's supported compaction seam.

It does **not** run a DSH `AgentLoop`, replace Prime's provider, or create a second conversation authority. No provider wrapper or ACP delegation path ships in the package.

See [`docs/inference-context-plan.md`](docs/inference-context-plan.md) for the broader rollout plan and [`docs/single-window-cache-architecture.md`](docs/single-window-cache-architecture.md) for the one-window, append-only, cache-epoch contract.

## Features

- Per-root and per-RLM-child context isolation.
- Append/no-op/rebuild projection tracking.
- Immutable snapshots tied to the exact Prime branch leaf and revision.
- Bounded transcript search, message reads, and private artifacts through Python.
- Provider-reported input/output/cache token metrics.
- Explicit durable context admission through recorded IPython results.
- Automatic bounded parent-to-child evidence capsules through stock Prime lifecycle hooks.
- Expiring, bounded parent-to-child context grants for explicit larger selections.
- Optional shadow telemetry that never mutates provider context.
- Optional Prime-committed compaction planning.

Prime JSONL is the only full-content authority. New durable context roots contain verified byte/line locators, IDs, and digests only; they never copy source or effective message bodies. Derived indexes are bounded and rebuildable.

## Install

```bash
cd prime-agent-dsh
npm install
npm run release:check
prime-agent package install "$PWD"
```

For project-local activation:

```bash
prime-agent package install --local "$PWD"
```

Automatic RLM inheritance uses stock Prime 0.9.5 lifecycle hooks. It pins the stable parent file at child `session_start`, admits task-ranked evidence at the first `before_agent_start`, and orders it request-locally in `context`. No Prime patch, provider call, or tool fallback is used.

Restart Prime Agent after installation. During development:

```bash
prime-agent -e ./extensions/index.ts
```

## Commands

- `/dsh-session status` — show the current isolated scope, revision, and cache metrics.
- `/dsh-session on` — enable context snapshotting for this Prime session.
- `/dsh-session off` — disable context snapshotting for this Prime session. Prime inference is unaffected.
- `/dsh-session capabilities` — summarize available sidecar features.
- `/dsh-session doctor` — verify the current session's artifact binding.
- `/dsh-context-status` — show optional shadow-mirror health.
- `/dsh-context-trace [count|clear]` — inspect content-free prefix telemetry.

## Python context objects

The shipped `dsh-context` skill installs the `dsh_context` module into every Prime kernel, including RLM child kernels.

```python
ctx = dsh_context.current()
ctx.entries(last=10)
ctx.messages(last=10)
ctx.search("authentication", limit=20)
ctx.metrics
```

Pin the current immutable view or create a private content-addressed artifact:

```python
snapshot = ctx.snapshot()
artifact = ctx.artifact(ctx.search("migration decision"), label="Migration evidence")
```

### Durable admission

Reading a snapshot does not silently alter model context. To admit selected material, print or return the bounded value from IPython:

```python
selection = ctx.search("migration decision", limit=8)
print(ctx.inject(selection, label="Relevant migration decisions"))
```

Prime records that tool result in its canonical session before a later model request can use it. Prime 0.9.5 does not expose a public extension hook for custom Python host requests, so the package does not write Prime JSONL directly.

### Native RLM inheritance and explicit grants

For an apparent native `rlm.spawn` descendant, the extension freezes the stable parent branch observed at child `session_start`. This is an observed cut, not Prime's inaccessible host-captured spawn leaf. It merges eligible local user/assistant/summary records with the immediate parent's validated capsule. It writes an atomic private admission under the child artifact directory. It then returns exactly one hidden, unprivileged `prime-agent-dsh/inherited-context-v1` message. The request-local `context` hook places that evidence immediately before the child task; DSH admission is durable before inference, while Prime custom-message persistence remains eventual. The child validates the local admission, payload, and canonical message automatically. This works at arbitrary depth. Root sessions are unchanged.

Capsules are bounded, quote evidence as untrusted data, and never contain system/developer text, tool inputs/results, credentials, provider state, or synthetic inherited messages. Prime remains authoritative for lineage, messages, tools, and inference.

A parent can also share a larger explicit bounded selection without copying its live session or authority:

```python
selection = ctx.search("authentication design", limit=12)
grant = ctx.grant(selection, label="Authentication evidence")
child = await rlm.spawn(
    "Review the design. " + grant.instruction,
    name="auth-review",
)
```

The descendant opens the explicit capability:

```python
evidence = dsh_context.open_grant("dsh-context-grant:...")
evidence.value
```

Grants are token-addressed, read-only, size-limited, and expiring. A child always gets its own session snapshot. The automatic capsule is tightly bounded; larger parent selections require an explicit grant.

## Optional configuration

| Variable or flag | Default | Purpose |
|---|---:|---|
| `PRIME_DSH_SHADOW_MODE` | `off` | Set to `on` for a second, diagnostic-only round-trip mirror. |
| `PRIME_DSH_SHADOW_MAX_MESSAGES` | `500` | Bound shadow work by message count. |
| `PRIME_DSH_SHADOW_MAX_BYTES` | `4194304` | Bound shadow work by serialized bytes. |
| `PRIME_DSH_COMPACTION_MODE` | `shadow` | Compaction planner mode: `off`, `shadow`, or explicit opt-in `active`. |
| `--dsh-compaction` | environment value | Per-process override for compaction mode. |
| `PRIME_DSH_PRUNE_THRESHOLD_CHARS` | `8192` | Tool-result pruning threshold for planned compaction. |
| `PRIME_DSH_PRUNE_HEAD_CHARS` | `4096` | Tool-result prefix retained by the planner. |
| `PRIME_DSH_PRUNE_TAIL_CHARS` | `1024` | Tool-result suffix retained by the planner. |

Shadow compaction observes Prime's supported `session_before_compact` lifecycle without changing the request. Explicit opt-in `active` mode uses Prime/pi-ai's public `completeSimple` provider API for the closest supported warm-prefix approximation: it replays the original unpruned message prefix with the current system prompt, active tools in order, selected/request-adjusted model and auth, stable session ID, and cache retention enabled, then appends one summary instruction. It returns a normal Prime `CompactionResult` and never edits session files directly. Because auxiliary calls cannot re-run other extensions' private `before_provider_request` transforms, keep shadow mode when another extension rewrites provider payloads.

## Storage and safety

Context objects are stored under the matching Prime session artifact directory:

```text
session-artifacts/<session>/dsh-context/
  BINDING
  CURRENT
  manifest.json                 # generated current-view pointer only
  objects/<sha256>.json         # immutable derived objects
  commits/<sha256>.json         # immutable generation commits
  heads/<generation>-<sha256>   # recovery authority
  artifacts/<sha256>.md
  grants/<capability-token>.json
../dsh-inheritance/
  HEAD                          # atomic PINNED/ADMITTED generation pointer
  generations/<state>-<sha256>/ # immutable pin/payload/admission set
```

Prime JSONL is the sole canonical history. Each lifecycle sync publishes a transactional, content-addressed generation. Recovery scans immutable heads and validates commits and objects; `CURRENT` and `manifest.json` are replaceable hints/views. A corrupt or interrupted publication therefore falls back to the newest valid retained generation. Append mode is used only after exact source and effective prefix proof; compaction, forks, and rewrites rebuild.

Derived checkpoints are immutable while retained, but retention is bounded to the two newest valid generations. Old heads are retired before their commits, objects, and compatibility manifests. Explicit cursors to retired snapshots report that the snapshot is unavailable. User `artifacts/` and `grants/` are never collected. Publication also stops for that session when the 64 MiB derived-store quota or 128 MiB free-space reserve would be crossed. Prime continues normally. After freeing space, run `/dsh-session on` to re-arm publication.

### Upgrade and restart

No manual data migration is required. Install this version and restart Prime Agent. The first publication under the new process removes legacy rebuildable snapshot layouts and compacts old derived generations under the writer lock. Prime JSONL, user artifacts, grants, and inheritance data are not changed. Do not delete session directories manually.

Directories use mode `0700`; files use mode `0600`. Object paths and digests are verified. Reads, search results, injected values, artifacts, and grants have hard size limits. Projection errors fail open and leave Prime's request unchanged.

These checks prevent accidental traversal, corruption, stale references, and unsafe cross-session reuse. They are not a hostile same-UID sandbox. Another process running as the same OS user can generally read or replace that user's files between checks. Native parent/child sessions are therefore treated as a cooperative lineage; use separate OS identities or a sandbox for mutually hostile agents.

## Validation

```bash
npm run typecheck
npm run lint
npm test
npm run test:python
npm run package:smoke
npm run release:check
```

The tests cover conversion, append/rebuild behavior, branch snapshots, root/child isolation, fail-open errors, Python search and admission, artifact permissions, child grants, tamper detection, packaging, clean production installation, extension discovery, and reload.

## Current boundary

This redesign intentionally does not expose DSH's full agent loop, tools, subagent tree, or independent persistence as part of normal Prime turns. Those features would create a second loop and context authority. Only loop-independent DSH context capabilities belong in this package unless Prime adds a supported middleware interface that preserves its lifecycle invariants.

## License

MIT. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for bundled dependency notices.
