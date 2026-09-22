# Support

`prime-agent-dsh` is a developer-preview community project. Support is best effort and has no guaranteed response time.

## Before asking for help

1. Read [Getting started](docs/getting-started.md) and its troubleshooting section.
2. Confirm the supported Prime and Node versions.
3. Reproduce with the current reviewed checkout and a non-sensitive session.
4. Run `npm run check` and, for install problems, `npm run package:smoke`.
5. Search existing GitHub issues.

## Ask a question or report a bug

Open an issue at <https://github.com/moreWax/prime-agent-dsh/issues> with:

- the `prime-agent-dsh` commit or version;
- Prime Agent, Node.js, npm, Python, and operating-system versions;
- whether registration is user-level, project-local, or `-e` development loading;
- minimal reproduction steps;
- expected and actual behavior;
- relevant command output with secrets and personal content removed.

Do **not** attach a complete Prime JSONL, DSH artifact, grant file, provider credential, or unredacted home path. A minimal synthetic reproduction is preferred.

General Prime Agent, provider, or Node installation problems may belong in the corresponding upstream project's support channel. This repository can only address behavior introduced by `prime-agent-dsh`.

## Security and sensitive reports

Do not disclose a suspected vulnerability in a public issue. Follow [SECURITY.md](SECURITY.md) and use the repository's private GitHub Security Advisory flow. Never include live credentials, capability tokens, or private session content in a report.

## Compatibility policy

The current runtime target is Prime Agent `0.9.5` or newer and Node.js `^22.19.0` or `>=24.0.0`. Because the project and its pinned DSH dependencies are previews, APIs and storage details can change between minor releases. Upgrade notes belong in [CHANGELOG.md](CHANGELOG.md).
