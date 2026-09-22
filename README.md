# prime-agent-dsh

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24-339933.svg)](package.json)
[![Status: developer preview](https://img.shields.io/badge/status-developer%20preview-orange.svg)](#project-status)

A context sidecar for Prime Agent. It turns the active Prime branch into a searchable, rebuildable DeepSeek Harness (DSH) projection, exposes bounded context tools in Python, and reports provider cache use. Prime remains the only agent loop and the only session authority.

> The pinned DeepSeek Harness `0.1.6-alpha.2` dependencies are developer previews. Review the security and compatibility notes before deployment.

## Why use it?

- Search and inspect a long Prime session without placing the whole transcript in the next request.
- Pin immutable views, create private artifacts, and explicitly admit selected evidence.
- Give native RLM descendants bounded inherited evidence or an explicit expiring grant.
- See provider-reported turn and session cache rates in a native Prime widget.
- Keep failures non-blocking: projection errors leave the Prime request unchanged.

## Quick start

Requirements, source installation, verification, upgrades, removal, and troubleshooting are in **[Getting started](docs/getting-started.md)**.

```bash
prime-agent package install npm:prime-agent-dsh
```

Restart Prime Agent after installation. Then run `/dsh` and try `dsh_context.current()` in IPython. Source and project-local installation instructions are in the getting-started guide.

## Architecture invariants

1. **Prime owns inference.** Prime selects models, streams responses, authenticates, retries, and controls approvals.
2. **Prime owns execution.** Tools, IPython, skills, MCP, native `rlm.spawn`, and goals stay in Prime's loop.
3. **Prime owns content and lifecycle.** Prime JSONL is the only full-content session authority. Prime alone branches, compacts, and deletes sessions.
4. **DSH is derived and fail-open.** Its per-session projection and indexes are bounded, content-addressed, and rebuildable. DSH does not compact Prime context.
5. **Scopes stay isolated.** Each root and native RLM child gets its own scope. Sharing uses a bounded capsule or explicit grant, never a live transcript or parent authority.
6. **Admission is explicit.** Reading DSH data does not silently add it to model context. Printed or returned `ctx.inject(...)` output becomes a normal Prime tool result.

The package does not ship a DSH `AgentLoop`, provider wrapper, ACP delegation path, custom model loop, or independent conversation store. See [Single-window cache architecture](docs/single-window-cache-architecture.md).

## Feature status

| Capability | Status | Notes |
|---|---|---|
| Active-branch projection | Available | Append/no-op/rebuild tracking; Prime JSONL stays canonical. |
| Transcript reads and search | Available | Bounded Python API over immutable session snapshots. |
| Snapshots and private artifacts | Available | Content-addressed and stored in the matching session artifacts. |
| Explicit context admission | Available | Use `ctx.inject(...)`; Prime records the resulting tool output. |
| Native RLM inheritance | Available | Bounded untrusted evidence through Prime 0.9.5 lifecycle hooks. |
| Explicit parent-to-child grants | Available | Bounded, read-only, expiring capabilities. |
| Provider cache metrics | Available when reported | No cache hit is inferred if the provider omits usage fields. |
| `/dsh` display toggle | Available | Changes widget visibility only; indexing continues. |
| Shadow telemetry | Optional | Diagnostic only; never changes provider context. |
| DSH-driven compaction | Not included | Prime alone decides and performs compaction. |
| DSH agent loop or tools | Not included | Would create a second execution authority. |
| npm installation | Available | `prime-agent package install npm:prime-agent-dsh` |

## Python API at a glance

```python
ctx = dsh_context.current()
ctx.entries(last=10)
ctx.messages(last=10)
ctx.search("authentication", limit=20)
ctx.metrics

snapshot = ctx.snapshot()
selection = ctx.search("migration decision", limit=8)
artifact = ctx.artifact(selection, label="Migration evidence")
print(ctx.inject(selection, label="Relevant migration decisions"))
```

For grants and API rules, see [Getting started](docs/getting-started.md#use-the-python-context-skill) and the [`dsh-context` skill reference](skills/dsh-context/SKILL.md).

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `PRIME_DSH_CACHE_DISPLAY` | `on` | Initial cache-rate widget visibility. Set `off` to hide it. |
| `PRIME_DSH_SHADOW_MODE` | `off` | Enable a second diagnostic-only round-trip mirror. |
| `PRIME_DSH_SHADOW_MAX_MESSAGES` | `500` | Bound shadow work by message count. |
| `PRIME_DSH_SHADOW_MAX_BYTES` | `4194304` | Bound shadow work by serialized bytes. |

## Documentation

- [Getting started](docs/getting-started.md)
- [Single-window cache architecture](docs/single-window-cache-architecture.md)
- [Durable context query](docs/durable-context-query.md)
- [Context spill](docs/context-spill.md)
- [Shadow telemetry validation](docs/shadow-telemetry-validation.md)
- [Contributing](CONTRIBUTING.md)
- [Support](SUPPORT.md)
- [Roadmap](ROADMAP.md)
- [Changelog](CHANGELOG.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)

## Project status

`0.2.1` is a developer preview. The Prime integration, storage formats, and Python API may change before a stable release. The test suite covers the documented core paths, but this package is not a security boundary against another process running as the same OS user.

The current runtime target is Prime Agent `0.9.5` or newer (`@earendil-works/pi-coding-agent >=0.86.1`). See the [roadmap](ROADMAP.md) for direction rather than release promises.

## Development and validation

```bash
npm run typecheck
npm run lint
npm test
npm run test:python
npm run package:smoke
npm run release:check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change. Preserve the Prime-only authority model.

## License

[MIT](LICENSE). Bundled dependency notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
