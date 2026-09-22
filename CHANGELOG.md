# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project intends to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once its public API stabilizes.

## Unreleased

### Documentation

- Added production-oriented installation, support, contribution, conduct, roadmap, and release documentation.

## 0.2.2 - 2026-09-22

### Added

- Added `/dsh help` for concise command and behavior guidance.

## 0.2.1 - 2026-09-22

### Changed

- Made npm installation the primary getting-started path after the verified v0.2.0 publication.
- Updated GitHub Actions to Node 24-based action runtimes.

## 0.2.0 - 2026-09-21

### Added

- Per-root and per-native-RLM-child context scopes.
- Immutable branch snapshots, bounded transcript reads and search, private artifacts, and explicit durable admission through the `dsh-context` Python skill.
- Automatic bounded parent-to-child evidence capsules and explicit expiring context grants.
- Provider-reported turn and session cache metrics in a native Prime widget.
- Incremental append-only Prime JSONL reference indexing with verified rebuild and recovery paths.
- Optional diagnostic-only shadow telemetry.

### Changed

- Reworked the integration as a fail-open context sidecar around Prime's native `AgentSession`.
- Made Prime JSONL the sole canonical full-content history and Prime the sole model, tool, session, branching, deletion, and compaction authority.
- Reduced user commands to `/dsh`, `/dsh on`, and `/dsh off`; these control display only.
- Pinned DeepSeek Harness dependencies to `0.1.6-alpha.2` and set the runtime target to Prime Agent 0.9.5 or newer.

### Removed

- DSH-driven compaction and warm-prefix compaction behavior.
- Alternate DSH agent loops, provider wrappers, ACP delegation, and independent conversation authority from the supported design.

### Security

- Added bounded stores, verified locators and digests, restrictive file modes, quota/free-space checks, grant expiry, and fail-open handling.
- Clarified that same-OS-user processes remain outside the filesystem threat boundary.

## 0.1.0 - 2026-09-01

### Added

- Initial experimental Prime Agent and DeepSeek Harness integration.

### Notes

- The 0.1.x line explored routing, shadow context, persistence, and compaction approaches. Those experiments are not the authority model supported by 0.2.0.
- No npm release is asserted for this version; repository history is the source of record.
