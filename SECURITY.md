# Security policy

## Supported versions

Security fixes are released on the current minor line. Upgrade to the newest patch before reporting a problem.

| Version | Supported |
| --- | --- |
| 0.2.x | Yes |
| 0.1.x and earlier | No |

Support for a release also requires a Node.js version allowed by that release's `engines` field and supported Prime peer dependencies.

## Report a vulnerability

Please report vulnerabilities privately with [GitHub Security Advisories](https://github.com/moreWax/prime-agent-dsh/security/advisories/new). Do not open a public issue, discussion, or pull request for an unpatched vulnerability. Include the affected version, platform, impact, reproduction steps or a minimal proof of concept, and any suggested mitigation. Remove real credentials and private transcripts.

We aim to acknowledge a report within five business days and provide a status update within ten business days. These are targets, not guarantees or an SLA. Timing depends on severity, reproducibility, maintainer availability, and coordinated disclosure needs. We will work with the reporter on disclosure after a fix or practical mitigation is available.

## Security model

Read the full [security and operations guide](docs/security.md) before deploying the package. Important limits are:

- Prime's session JSONL is the sole authority for transcript content. DSH indexes and projections are derived and rebuildable.
- DSH protects against accidental traversal, symlink substitution, corruption, and cross-session reuse. It is not a sandbox against another process running as the same OS user.
- Session artifacts contain sensitive metadata and can contain selected context, exact task prompts, user-created artifacts, grants, and attachments. Treat the whole session tree as confidential.
- DSH does not replace Prime's provider, retention, deletion, authentication, backup, or secret-management controls.
