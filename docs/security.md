# Security and operations guide

This guide describes the security boundary of `prime-agent-dsh` 0.2.x. It supplements, but does not replace, the controls of Prime Agent, the operating system, the selected model provider, and your backup system.

## Trust boundaries

Prime owns the agent loop, tool execution, provider request, canonical session JSONL, compaction, and session lifecycle. DSH observes committed Prime history and creates local, derived state. **The Prime JSONL is the sole content authority.** A DSH manifest, `CURRENT` file, index, object, commit, or shadow trace must never be treated as a replacement transcript. Reference projections are rebuilt and checked against the canonical JSONL.

The installation assumes that Prime, this package, its configured dependencies, and native parent/child sessions are cooperative. DSH rejects unsafe paths and corrupt objects, but it is not a hostile multi-tenant boundary. A process with the same OS user ID can generally read or modify session files, inspect process memory, race checks, or debug the Prime process. File modes do not stop that process. Run mutually hostile agents under separate OS identities, containers, or stronger sandboxes, and isolate their session and attachment roots.

DSH is not an authorization layer for Prime tools. A tool that can read a file or environment variable can still place its value in the canonical transcript or send it through Prime's normal model request.

## Data inventory and metadata

The normal derived context store contains content-free references into Prime JSONL, content digests, offsets, lengths, line and entry identifiers, branch/session identifiers, absolute canonical file paths, timestamps, token counts, roles, and publication diagnostics. It does not copy message bodies into derived objects or the incremental index. Queries resolve references by reading and validating Prime JSONL.

This metadata is still sensitive. Paths and identifiers reveal host layout and activity. Sizes, timings, roles, token counts, and equality or prefix relationships can reveal usage patterns. SHA-256 digests can confirm guesses about low-entropy content. Do not publish manifests, indexes, fingerprints, traces, or error logs merely because they omit message bodies.

Other DSH state can contain content:

- `dsh-inheritance/` generations contain bounded, selected parent text after best-effort secret redaction, generated capsules, and the child's **exact task prompt**. Task prompts are not redacted.
- `dsh-context/artifacts/` contains exact values explicitly saved by the user.
- `dsh-context/grants/` contains exact bounded values and capability tokens created for descendants.
- local attachment storage can contain verbatim files or images admitted by the attachment backend.
- Prime JSONL remains a complete source of any sensitive content committed by Prime.

Treat the full Prime session tree, DSH artifact tree, attachment store, diagnostic output, and backups as confidential.

## Local files and integrity controls

On POSIX systems DSH creates or tightens its managed directories to mode `0700` and creates managed files with mode `0600`. Host ACLs, mount options, backup agents, copied/restored files, and the permissions of ancestor directories remain operator responsibilities. Check them after migration or restore. Do not place session state on a shared or untrusted filesystem.

The durable store binds a session ID to the canonical real path of its Prime JSONL. It rejects store-root symlinks and symlinks within managed paths, rejects traversal outside the bound root, validates file type and size, uses exclusive temporary files and atomic rename, and fsyncs publication boundaries where the platform supports it. Content-addressed commits and objects, heads, source locators, attachment references, and inheritance artifacts are checked with digests and session bindings before use. `CURRENT` and compatibility manifests are hints, not recovery authority. Corrupt, stale, mismatched, or incomplete generations are rejected or ignored.

These controls reduce accidental substitution and corruption. They do not eliminate time-of-check/time-of-use races by a same-UID attacker, protect a compromised Prime process, or provide authenticity against an attacker who can rewrite all bound state. SHA-256 here is an integrity and content-addressing mechanism, not encryption or a secret MAC.

## Provider and telemetry boundary

Prime sends the active request to the selected remote model provider under Prime's configuration and that provider's policy. DSH does not add a provider or make an additional model request. `PRIME_DSH_SHADOW_MODE=on` performs a bounded local conversion round trip and passively observes the provider payload that Prime is already preparing; it does not transmit that mirror itself.

Shadow telemetry is process-local and retains counters, byte lengths, timestamps, truncated display fingerprints, and full SHA-256 fingerprints/chunk fingerprints needed for prefix comparison. It temporarily serializes observed content in memory but does not retain provider request bodies or credentials as plaintext telemetry. Credential-shaped object keys are replaced before fingerprinting. This redaction is defense in depth, not a complete secret detector: secrets in ordinary message strings still influence one-way fingerprints. `/dsh-context-trace clear` clears process-local traces, and process exit clears them. Provider-reported cache token counts are copied into local manifests and status data; DSH cannot verify provider accounting.

Review Prime and provider logging, training, residency, retention, and incident policies separately. Disabling DSH telemetry does not stop Prime's normal provider request.

## Retention, deletion, and backup

The derived publication store normally retains the two newest complete generations. Its quota and pruning apply to rebuildable commits, objects, heads, indexes, and compatibility manifests. They do **not** collect user `artifacts/`, `grants/`, inheritance generations, Prime JSONL, or all attachment objects. Grant expiry prevents a grant from being opened through the API; it does not erase the grant file. An artifact has no automatic expiry.

Use Prime's native Agents view to delete a session (`Ctrl+X` twice to confirm in the supported UI). DSH has no separate session-deletion or secure-erasure command. Prime is expected to remove the matching session artifact directory. Verify deletion of the canonical JSONL, matching `session-artifacts/<session>/`, descendant/inheritance directories, attachment objects that are no longer referenced, exported diagnostics, and applicable backups according to your Prime version and local layout. Filesystems, snapshots, SSD wear levelling, remote sync, and backups can retain copies; ordinary deletion is not guaranteed secure erasure.

Back up the canonical Prime JSONL and any user artifacts that must survive. The `dsh-context` projection is disposable and can be rebuilt; backing it up is optional. If DSH state is backed up, preserve its association with the matching canonical JSONL and session directory rather than restoring it under a different session. Stop writes or use a filesystem-consistent snapshot. Encrypt backups, restrict access, test restores, and apply the same retention policy as for transcripts. After a partial or uncertain restore, discard the derived projection and allow DSH to rebuild it from Prime JSONL.

## Secret handling

Do not put API keys, cookies, passwords, private keys, connection URLs, or production customer data in prompts, task text, artifacts, grant values, filenames, labels, or transcripts. Use the platform's secret store or environment injection and pass opaque references where possible. Scope credentials narrowly and use short-lived values.

Inheritance applies best-effort pattern redaction to eligible parent text. It cannot identify every secret, and the exact child task prompt is persisted for binding and resume checks. Canonical history, explicit artifacts, grants, and attachments are not general-purpose redaction services. Never rely on hash-only metadata or redaction to make a secret safe after exposure. Avoid placing secrets in low-entropy content because fingerprints can permit guess confirmation.

Before sharing a bug report, archive, screenshot, trace, or test fixture, replace real session IDs, paths, capability tokens, transcript text, and credentials. Never send live secrets in a GitHub Security Advisory.

## Operational checks

- Install only expected package versions and review lockfile changes. Run with a supported Node.js release and supported Prime peer dependencies.
- Keep session and attachment roots on local, access-controlled storage. Verify ownership, `0700` directories, `0600` files, and restrictive ancestor permissions.
- Leave `PRIME_DSH_SHADOW_MODE=off` unless local diagnostics are needed. Clear traces and restart after diagnostics.
- Monitor DSH warnings, disabled publication, integrity failures, unexpected permission changes, storage quota failures, and unfamiliar session descendants.
- Use separate OS users or sandboxes for different trust domains. Do not grant untrusted agents access to another agent's session tree or capability URI.
- Test Prime-native session deletion and encrypted backup restore in the actual deployment.

## Incident response

1. Stop affected Prime processes and isolate the host or session storage. Preserve read-only copies if forensic evidence is required.
2. Assume exposed transcript text, task prompts, artifacts, grants, attachments, environment-derived values, and backups are compromised. Revoke and rotate credentials and provider tokens; invalidate or remove grants.
3. Record package, Prime, Node.js, provider, and OS versions. Preserve relevant canonical JSONL and file metadata without publishing them.
4. Remove untrusted derived state. After the canonical JSONL and host are known-good, let DSH rebuild its projection. Do not use a clean rebuild as proof that the canonical transcript is safe.
5. Review provider and Prime audit data for unexpected requests. Follow their incident procedures for remote disclosure or account compromise.
6. Report a suspected package vulnerability privately through the process in [`SECURITY.md`](../SECURITY.md). Coordinate public disclosure with the maintainers.
7. After containment, verify permissions, session deletion behavior, backup copies, dependency integrity, and separation between trust domains.
