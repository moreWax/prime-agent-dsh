# Roadmap

This roadmap describes direction, not a release promise. Priorities can change after testing and upstream Prime or DSH changes. There are no committed dates.

## Non-negotiable boundary

Prime remains the sole authority for model calls, tools, sessions, branches, persistence, compaction, deletion, and lifecycle. Prime JSONL remains the only canonical full-content history. DSH stays a derived, bounded, fail-open context sidecar.

The roadmap does **not** include:

- DSH-driven context compaction;
- a second agent or tool loop;
- a provider wrapper or ACP delegation route;
- an independent canonical conversation store;
- hidden admission of context read through Python.

These are architecture constraints, not deferred features.

## Near-term priorities

- Broaden compatibility and regression testing across supported Prime, Node, and provider combinations.
- Improve diagnostics for disabled publication, stale snapshots, provider metrics, and storage limits without exposing private content.
- Exercise install, update, removal, clean-package, and restart flows in release checks.
- Keep lifecycle inheritance bounded and verify it at greater native RLM depth.
- Expand storage recovery, corruption, truncation, quota, and concurrency tests.
- Document upgrade and compatibility changes with each release.

## Before a stable release

- Define and document stability guarantees for the Python context API and on-disk derived formats.
- Establish a repeatable source release process and signed or otherwise verifiable release artifacts where practical.
- Publish a tested compatibility matrix.
- Complete privacy and threat-model review for artifacts, grants, inheritance, and shadow telemetry.
- Decide whether npm publication is useful and supportable. Until that decision and a verified release occur, installation remains source-only.

## Possible later work

The following items require evidence, design review, and Prime-compatible public hooks:

- richer native UI diagnostics that retain host-controlled layout and styling;
- more precise provider-cache analysis when providers expose authoritative fields;
- additional bounded query operators and export formats;
- configurable retention that does not weaken snapshot validity or Prime ownership;
- supported middleware integration if Prime exposes an API that preserves all authority invariants.

## How to propose work

Open an issue describing the user problem, the smallest useful behavior, validation criteria, privacy effects, and how the design preserves Prime-only authority. See [CONTRIBUTING.md](CONTRIBUTING.md).
