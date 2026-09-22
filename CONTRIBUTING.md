# Contributing

Thanks for helping improve `prime-agent-dsh`. This project is a developer preview, so small, test-backed changes are easiest to review.

## Before opening a change

- Search existing issues and pull requests.
- For a large feature or an architecture change, open a proposal first.
- Do not include session logs, provider credentials, capability tokens, or private artifacts in an issue or test fixture.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Architecture constraints

Every contribution must preserve these boundaries:

- Prime is the only model/tool loop and the only authority for sessions, branches, inference, tools, compaction, and deletion.
- Prime JSONL is the sole canonical full-content history.
- DSH state is derived, bounded, rebuildable, per-session, and fail-open.
- DSH must not compact Prime context or add a second conversation store.
- Context admission must be visible through normal Prime records. Reading a context object must not silently alter provider context.
- Native RLM lineage may carry bounded untrusted evidence, but not parent authority, credentials, system/developer content, or tool inputs/results.

A proposal that needs a DSH agent loop, provider wrapper, ACP delegation route, or independent lifecycle is outside the current project boundary.

## Development setup

Requirements are listed in [Getting started](docs/getting-started.md#requirements).

```bash
git clone https://github.com/moreWax/prime-agent-dsh.git
cd prime-agent-dsh
npm install
npm run check
```

Run a development checkout without installing it globally:

```bash
prime-agent -e ./extensions/index.ts
```

Use disposable Prime sessions for manual testing. Do not test with sensitive transcripts.

## Tests and quality gates

Before submitting a pull request, run:

```bash
npm run typecheck
npm run lint
npm test
npm run test:python
npm run package:smoke
```

`npm run release:check` runs all release gates. Add focused tests for behavior changes. Test fail-open behavior and tamper or truncation cases when they apply.

For documentation changes:

- keep relative links valid;
- distinguish tested behavior from plans;
- do not imply npm publication;
- update `CHANGELOG.md` under `Unreleased` for user-visible changes.

## Pull requests

Explain:

1. the user problem;
2. the behavior before and after;
3. why Prime-only authority remains intact;
4. validation commands and results;
5. privacy, persistence, or compatibility effects.

Keep commits reviewable. A maintainer may ask for a narrower change or additional tests. Submission does not guarantee inclusion or a release schedule.

## Reporting security problems

Do not open a public issue containing an unpatched vulnerability, secret, session content, or grant token. Follow the private-contact guidance in [SUPPORT.md](SUPPORT.md#security-and-sensitive-reports).
