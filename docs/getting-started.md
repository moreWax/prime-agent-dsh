# Getting started

This guide installs `prime-agent-dsh` from source. Version 0.2.0 is **not published to npm**.

## Requirements

- Prime Agent `0.9.5` or newer.
- Node.js `^22.19.0` or `>=24.0.0`.
- npm and Git.
- A Prime provider that reports cache usage if you want cache-rate values. The context features do not require those metrics.
- Write access to the Prime configuration and session-artifact locations used by your installation.

Check the tools that are on your path:

```bash
prime-agent --version
node --version
npm --version
git --version
```

The package declares `@earendil-works/pi-coding-agent >=0.86.1` and related Prime packages as peer dependencies. `npm install` installs the pinned DSH runtime dependencies and development tools.

## Install from GitHub

Clone the repository, validate the exact checkout, and register that checkout with Prime:

```bash
git clone https://github.com/moreWax/prime-agent-dsh.git
cd prime-agent-dsh
npm install
npm run release:check
prime-agent package install "$PWD"
```

Use a tagged release or reviewed commit when one is available. The default branch can contain unreleased work. Do not use `npm install -g prime-agent-dsh` or `npm install prime-agent-dsh`; no npm package is published for this release.

## Install for one project

If you already have a trusted checkout and want activation only in the current project, run this **from the project that should use the package**:

```bash
prime-agent package install --local /absolute/path/to/prime-agent-dsh
```

Without `--local`, Prime registers the package in the user configuration. With `--local`, Prime registers it in the current project's configuration. The source checkout still needs its dependencies:

```bash
cd /absolute/path/to/prime-agent-dsh
npm install
npm run release:check
```

For extension development without registration, Prime also supports:

```bash
cd /absolute/path/to/prime-agent-dsh
prime-agent -e ./extensions/index.ts
```

Use that command only for a development run. Do not also activate the installed copy in the same run.

## Restart and verify

Package registration does not change an already running Prime process. Exit all Prime Agent processes that should load the package, then start Prime again. A new process loads the extension and installs the `dsh-context` skill into its Python kernel.

First verify package registration:

```bash
prime-agent package list
```

Confirm that the output includes the source you installed. In the restarted Prime session:

1. Run `/dsh`. Prime should report the resulting display and indexing state.
2. Open IPython and evaluate:

   ```python
   ctx = dsh_context.current()
   ctx
   ctx.entries(last=3)
   ctx.metrics
   ```

3. Continue the conversation for at least one completed assistant request. `ctx.entries(...)` should reflect the active Prime branch.

Cache rates can remain `—` when the provider does not report enough usage data. That does not mean projection failed. If the session has no publishable history yet, make a normal turn and retry.

## Control the cache display

```text
/dsh
/dsh on
/dsh off
```

- `/dsh` toggles the native cache-rate text and reports the resulting state.
- `/dsh on` shows it.
- `/dsh off` hides it.

The command controls display only. Projection, indexing, and provider cache measurement continue while the display is hidden. A typical provider-reported value is:

```text
DSH cache · turn 99.7% · session 97.1%
```

`turn` covers the latest completed assistant request. `session` aggregates the canonical active Prime branch. Both use `cacheRead / (input + cacheRead)`. Prime controls where its native widget appears.

Set `PRIME_DSH_CACHE_DISPLAY=off` before starting Prime to make hidden the initial state.

## Use the Python context skill

Inspect bounded values without changing model context:

```python
ctx = dsh_context.current()
ctx.entries(last=10)
ctx.messages(last=10)
ctx.search("authentication", limit=20)
ctx.metrics
```

Pin the current immutable view and save selected material as a private artifact:

```python
snapshot = ctx.snapshot()
selection = ctx.search("migration decision", limit=8)
artifact = ctx.artifact(selection, label="Migration evidence")
```

Reading or searching does not silently add data to the next model request. Explicitly admit a bounded selection by printing or returning it from the IPython cell:

```python
print(ctx.inject(selection, label="Relevant migration decisions"))
```

Prime records that output in its canonical JSONL before a later request can use it. `ctx.admit(...)` is an alias.

To share a larger selected value with a native RLM child:

```python
selection = ctx.search("authentication design", limit=12)
grant = ctx.grant(selection, label="Authentication evidence")
child = await rlm.spawn(
    "Review the design. " + grant.instruction,
    name="auth-review",
)
```

The child follows the instruction or opens the URI directly:

```python
evidence = dsh_context.open_grant("dsh-context-grant:...")
evidence.value
```

Grants are bounded, read-only, and expiring. They share selected evidence, not the parent's tools or live session. Native children also receive a small automatic evidence capsule through Prime lifecycle hooks.

## Update

Updates are source updates, not npm upgrades. Stop Prime, then update the same checkout and validate it:

```bash
cd /absolute/path/to/prime-agent-dsh
git fetch --all --tags
git checkout <reviewed-tag-or-commit>
npm install
npm run release:check
prime-agent package install "$PWD"
```

If the package was registered locally, run the last command from the target project with `--local` and the absolute checkout path. Restart Prime afterward. `prime-agent package update [source]` exists for package sources that Prime can update, but a manual checkout update makes the reviewed revision explicit.

No manual data migration is required for 0.2.0. On first publication, it removes legacy rebuildable snapshot layouts and prunes old derived generations under the writer lock. It does not change Prime JSONL, user artifacts, grants, or inheritance data.

## Uninstall

First identify the registered source:

```bash
prime-agent package list
```

Remove the same source value used at installation:

```bash
prime-agent package remove <source>
```

For a project-local registration, run from that project and include `--local`:

```bash
prime-agent package remove --local <source>
```

Restart Prime. Removal stops future extension loading. It does not delete source checkouts or existing Prime sessions and artifacts. Remove a checkout separately only after unregistering it.

## Delete a session

DSH adds no deletion command. Use Prime's native **Agents** view:

1. Select the session.
2. Press `Ctrl+X` twice to confirm.

Prime deletes the matching session artifact directory. Do not manually remove individual DSH files from a live session. Prime alone owns session deletion and compaction.

## Troubleshooting

### The command or Python module is missing

- Run `prime-agent package list` and confirm the expected source is registered.
- Restart every Prime process after install or update.
- Run `npm install` in the checkout.
- Do not load both the installed package and `-e ./extensions/index.ts`.
- Confirm Prime and Node meet the versions above.

### Cache rates show `—`

The provider did not report enough cache usage data for that request or branch. This is expected for some providers. It does not disable indexing or context objects.

### Entries look stale

Make a normal Prime turn, then call `dsh_context.current()` again. Handles point to immutable snapshots, so create a new handle to observe a newer publication. If publication stopped because of its storage safety limits, free disk space and restart Prime to re-arm it.

### Validation fails

Run individual checks to locate the failing layer:

```bash
npm run typecheck
npm run lint
npm test
npm run test:python
npm run package:smoke
```

Keep the complete command and output when requesting support. Do not include secrets or an unredacted session log.

### Prime still works but DSH data is unavailable

This is the intended fail-open behavior. Projection errors leave Prime's request unchanged. Review the Prime process output, available disk space, checkout dependencies, and file permissions. The derived store stops publishing before it would exceed its 64 MiB quota or the 128 MiB free-space reserve; restart after correcting the condition.

## Privacy and data handling

- Prime JSONL is the only full-content history. DSH reads the active branch and creates derived, rebuildable indexes and immutable objects under the matching Prime session artifact directory.
- New index roots store locators, IDs, offsets, lengths, and digests rather than a second full message-body store.
- User-created artifacts and grants can contain the selected content you give them. They are not removed by derived-generation pruning.
- Automatic child capsules can contain bounded user, assistant, and summary evidence. They exclude system/developer text, tool inputs/results, credentials, provider state, and synthetic inherited messages.
- Shadow telemetry is off by default. When enabled, it performs a second diagnostic-only round trip and therefore can send bounded mirrored context to the configured provider. Review [shadow telemetry validation](shadow-telemetry-validation.md) before enabling it.
- Directories use mode `0700`; files use `0600`. These permissions are not a hostile same-user sandbox. Another process running as your OS user can generally access or replace your files.
- Context sent in normal requests, explicit admissions, and shadow diagnostics remains subject to your Prime provider's data handling terms.

Before sharing logs or artifacts, inspect and redact them. Use separate OS identities or a sandbox for mutually hostile agents.
