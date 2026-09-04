## Transparent DSH provider wrapping

By default, users select ordinary Prime models exactly as before. Provider IDs, model picker entries, catalogs, and authentication are unchanged. The extension wraps each native provider’s `streamSimple` so each turn routes into an in-process DeepSeek Harness tree. Use `/dsh-transparent off` for the current process, or set `"transparent": false` in `~/.prime/agent/dsh.json` (or `PI_DSH_TRANSPARENT=0`) to opt out. `/dsh-transparent on|status` enables or reports it.

The legacy `dsh` picker entry remains available for compatibility. Selecting it also routes each Prime turn into an in-process DeepSeek Harness tree. DSH owns the full agent loop, context, tools, skills, memory, subagents, and compaction. Prime only displays the streamed assistant text, reasoning, and tool activity.

The provider is workspace-confined by default. Its embedded DSH tree uses `workspace-write` with approval policy `ask`. DSH alpha.5 approval requests are bridged to Prime's confirmation UI and grant only the requested action. Non-interactive sessions have no answerer and fail closed. Set `"fullAccess": true` in `~/.prime/agent/dsh.json`, or the exact environment value `PI_DSH_FULL_ACCESS=1`, only when unrestricted host access without prompts is intended.

The Loader boot config is created exclusively as mode `0600` inside an unpredictable, owner-only `0700` temporary directory, then removed after boot. This prevents predictable-name symlink replacement.

The default `pool` mode keeps one persistent DSH session per Prime conversation. Sessions survive host-level Prime session disposal and are reclaimed by idle TTL and LRU limits. Configure it with `~/.prime/agent/dsh.json` (or `$PRIME_AGENT_HOME/dsh.json`) or `PI_DSH_MODE`, `PI_DSH_POOL_MAX`, and `PI_DSH_POOL_IDLE_TTL_MS`. The `oneshot` mode remains a subprocess fallback. The embedded API and its complete `@deepseek-ai/dsh-*` dependency graph are pinned to DeepSeek Harness `0.1.2-alpha.5`.

### Optional MCP and persistent terminal

Operators can add pooled-agent capabilities in `~/.prime/agent/dsh.json`:

```json
{
  "persistentTerminal": false,
  "mcpServers": [
    { "transport": "stdio", "serverName": "local", "command": "/absolute/path/to/server", "args": [] },
    { "transport": "streamable-http", "serverName": "remote", "url": "https://example.test/mcp", "headers": { "Authorization": "Bearer operator-secret" } }
  ]
}
```

Both features default off. Stdio commands and optional working directories must be absolute. HTTP endpoints must use `http` or `https`. Server names must match `[A-Za-z0-9_-]{1,32}` and be unique. Invalid entries are ignored with a warning. Initial MCP connection failure aborts unpublished Agent creation. Servers and the persistent shell are Agent-scoped and are disposed with the pooled Agent. There is no model-facing server-management tool, so only the operator-owned config can select commands, URLs, environment values, or headers. Treat those fields and this file as secrets.

Alpha.5 already mounts `web_search` and SSRF-guarded anonymous `web_fetch` in the base bundle. Search resolves `DEEPSEEK_API_KEY` per request through DSH credentials (`$DSH_HOME/.credentials.yaml`, inherited environment, then project/user `.env` fallback) and uses DeepSeek's separate Messages/search endpoint. This package does not copy Prime provider credentials into DSH or accept web credentials in `dsh.json`.

# prime-agent-dsh

A self-contained [Prime Agent package](https://github.com/PrimeIntellect-ai/prime-agent) that adds a **DeepSeek Harness inference-context shadow** without replacing Prime behavior, plus optional explicit delegation to the real [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) runtime.

This is **not** a DeepSeek model-provider plugin. The Prime extension launches `dsh --profile acp`, drives it with standard ACP, and routes DSH inference through the model currently selected in Prime. The included DSH bundle uses DSH's stock ACP subagent provider to launch `prime-agent --mode acp` in the reverse direction. DeepSeek Harness remains responsible for its own agent loop, append-only session log, context projection, compaction, tools, skills, subagents, Cordis plugins, and optional memory plugins.

> DeepSeek Harness is currently a developer preview and warns that breaking changes are expected. This package pins the DSH runtime and ACP SDK versions exactly.

## Install locally

```bash
cd prime-agent-dsh
npm install
prime-agent package install "$PWD"
```

For project-local activation:

```bash
prime-agent package install --local "$PWD"
```

Restart Prime Agent after installation. During development, use:

```bash
prime-agent -e ./extensions/index.ts
```

## Use

Ask Prime Agent to delegate a task to DeepSeek Harness, or explicitly use the tool:

- Tool: `deepseek_harness`
- Command: `/dsh <task>`
- Status: `/dsh-status`
- Full route check: `/dsh-doctor`
- Inference-context shadow health: `/dsh-context-status`
- Last content-free prefix trace: `/dsh-context-trace`

The tool returns a DSH session ID. On the same Prime branch, later calls automatically continue the latest DSH session; callers may also pass the ID explicitly. Forking before a DSH result mints a separate DSH session.

## Transparent inference-context integration

Transparent provider wrapping is active by default. Ordinary provider IDs and model picker entries remain unchanged, while DSH owns the model-facing loop, context, tools, skills, sessions, and compaction. Set `PI_DSH_TRANSPARENT=0` to retain native Prime dispatch. The inference-context projection experiment remains in **shadow mode**. The extension observes final provider payloads, fingerprints request envelopes, measures stable-prefix eligibility, and compares it with actual provider-reported `cacheRead`/`cacheWrite`. It does not mutate context yet.

The detailed shadow-first implementation and rollout plan is in [`docs/inference-context-plan.md`](docs/inference-context-plan.md). Context projection and pruning will only enter the provider path after differential tests prove Prime behavioral parity and fail-open recovery.

## Upgrade from v0.0.1

v0.0.2 replaces the narrow DSH SDK transport with ACP. Old caller-minted `prime-…` session identifiers are migrated to a fresh ACP session on first use; their old SDK history is not imported. New ACP-assigned IDs resume normally.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PRIME_DSH_PROFILE` | `acp` | Compatibility setting; the Prime bridge currently enforces the ACP profile |
| `PRIME_DSH_HOME` | `~/.prime/agent/deepseek-harness` | Isolated DSH home and persistence |
| `PRIME_DSH_PATCHES` | empty | Comma/semicolon-separated Cordis patch paths |
| `PRIME_DSH_BIN` | package-pinned DSH CLI | Optional explicit compatible `dsh` executable |
| `PRIME_DSH_INITIALIZE_TIMEOUT_MS` | `15000` | Initialize handshake timeout |
| `PRIME_DSH_PROJECTION_MODE` | `shadow` | Projection promotion gate: `shadow`, `canary`, or `active` |

The equivalent CLI flags `--dsh-bin` and `--dsh-home` override those two paths.

Model selection and authentication remain Prime Agent concerns. Users select ordinary Prime models in `/model`; the package does not add a `dsh` or `dsh-harness` picker entry. At session start it replaces each native provider with an identity-preserving decorator. The decorator keeps the provider ID, model catalog, authentication, refresh policy, and deferred operations, but routes normal streams through the persistent DSH pool. The already-resolved request credential and endpoint become a loopback capability route, so DSH never receives or persists the upstream credential. Model changes create a distinct route fingerprint and pooled DSH session while Prime session history continues to record the native provider/model identity.

The current release supports Prime models whose wire API is `openai-completions`, `openai-responses`, or `anthropic-messages`, matching DSH's public `llm-pi-ai` adapter. Unsupported provider-specific protocols fail explicitly rather than silently changing request semantics.

### Projection promotion gate (developer preview)

The model-wrapper proof of concept has a strict promotion gate. It converts the
complete Prime message list to DSH, projects it back, rebuilds the full provider
context, and selects that candidate only when it has exact deep structural parity
with the original context. Any sync, projection, validation, conversion, or parity
failure returns the original `Context` object unchanged.

`PRIME_DSH_PROJECTION_MODE` defaults to `shadow`. `canary` additionally requires
an explicit per-branch canary selector supplied by the embedding controller; with
no selector it stays fail-open on native Prime context. `active` authorizes selection
only after the same parity gate. None of these modes changes model auth or dispatch.

## DSH → Prime installation

The `dsh/` directory is a separately installable DSH bundle. For local development, install its dependencies first, then add it to a base-backed DSH application profile:

```bash
npm --prefix ./dsh install
dsh plugin --profile web add "$PWD/dsh"
```

This adds the DSH model-facing tool `prime_subagent`. It uses the maintained `@deepseek-ai/dsh-subagent-acp` provider and runs isolated `prime-agent --mode acp --no-session` children. This baseline reverse path is intentionally one-shot and defaults to rejected permission prompts.

The DSH bundle is not loaded by Prime's `pi` manifest; it is installed independently using DSH's native package manager.

## Context and memory boundary

Prime and DSH intentionally keep separate histories:

1. Prime calls the bridge with a self-contained task.
2. The ACP client queues that task into a DSH session.
3. DSH logs it durably and derives future model context from its own event stream.
4. Follow-ups reuse the DSH session ID.
5. Prime receives the committed final response and bounded progress summaries.

The bridge does **not** replay Prime's complete transcript into DSH. Doing that would duplicate context and undermine DSH's invariant that model-visible inputs are reconstructable from its session log.

Memory behavior depends on the selected DSH profile and installed DSH plugins. The bridge preserves those features; it does not pretend every optional memory plugin is installed.

## Capability evidence

Run `/dsh-capabilities` to see an evidence-backed inventory. `loaded` means the pinned `dsh-base` composition mounts the service; it does not mean the integration path has been exercised. `verified` requires bridge or live-test evidence. Current verified bridge paths include raster images (PNG, JPEG, WebP, GIF), structured user questions and plan review, while optional MCP and persistent PTY terminals are not part of the stock embedded base composition. Subagents, workflows, and jobs are verified by `npm run test:live` against the actual embedded DSH tree and a deterministic local OpenAI-compatible model. The probe starts one foreground child, runs a one-child worker workflow, and starts then collects one background child job. Goals, compaction, and projection cache remain only composition-verified. Web fetch/search is credential-dependent. The capability report is deliberately conservative and does not treat an installed package as loaded.

### Embedded lifecycle and limits

Embedded DSH keeps the upstream ownership rules: foreground subagent calls settle before their tool result, workflow runs are disposed after settlement, and jobs stay process-local and owner-scoped until collected, cancelled, or the tree is disposed. The bridge overlays conservative bounds on the stock base profile: subagent recursion depth `2`; workflow concurrency `4`, total children `16`, items per combinator `64`, synchronous-script timeout `2s`, and disposal grace `2s`; job waits default to `5s` and clamp at `30s`. Job completion delivery is `quiet`, which avoids model-driven wake loops. These are per-tree safety bounds, not durable queues or security isolation. Worker workflows remain a containment boundary, not a sandbox, and jobs/workflows do not resume after process loss.

## Security and limitations

- DSH is a nested code-executing agent. Its full base-backed ACP profile currently defaults to workspace-write, but Cordis patches and third-party plugins are trusted code and can change the security boundary.
- DSH permission requests are mapped to Prime's UI and fail closed when no UI is available.
- Patch paths are operator configuration only; the model-facing tool cannot choose arbitrary patches, profiles, binaries, environment variables, or working directories.
- ACP cancellation is forwarded through `session/cancel`. The subprocess is closed only during bridge shutdown or if the transport fails.
- One ACP subprocess is reused per workspace/configuration. Calls on it are serialized.
- ACP `session/prompt` settles after the DSH agent reaches its defined terminal boundary; calls are serialized conservatively by the bridge.
- `stdout` belongs exclusively to ACP JSON-RPC. Never install a DSH plugin that writes arbitrary output to stdout in the ACP profile.

## Durable compaction planner (preview)

The Prime extension can shadow or activate a DSH-style compaction plan at Prime's
`session_before_compact` hook. This is deliberately the **only** mutation seam:
the normal `context` and provider-request observers remain passive. The planner
keeps Prime's already balanced cut/retained tail, then applies DSH's deterministic
Unicode-code-point head/marker/tail rule to oversized text tool results in the
summarized region. Images and other rich blocks retain their relative order.

The default is `off`. Opt in to diagnostics without changing durable history:

```sh
PRIME_DSH_COMPACTION_MODE=shadow prime-agent
# or: prime-agent --dsh-compaction shadow
```

Use `active` only to authorize the validated plan. Prime's selected model, auth,
cancellation signal, instructions, and durable `CompactionResult` commit path are
still authoritative; planner or compactor errors fail open to native compaction.
Budgets default to 8192/4096/1024 characters and can be overridden with
`PRIME_DSH_PRUNE_THRESHOLD_CHARS`, `PRIME_DSH_PRUNE_HEAD_CHARS`, and
`PRIME_DSH_PRUNE_TAIL_CHARS`.

## Development

```bash
npm install
npm run check
```

Relevant upstream interfaces:

- `packages/acp/acp/README.md`
- `packages/bundle/acp-app/README.md`
- `packages/subagent/subagent-acp/README.md`
- `docs/architecture.md`

## License

MIT. DeepSeek Harness and its transitive dependencies retain their own licenses and notices.

## Upstream prior art

The pooled DSH provider implementation is adapted from [fatwang2/pi-dsh](https://github.com/fatwang2/pi-dsh) under the MIT License. See `THIRD_PARTY_NOTICES.md`.

## Live provider validation

The pooled provider has been validated against Prime Agent 0.9.1 and DSH 0.1.2-alpha.5. Selecting any supported native Prime model transparently routes its inference through DSH while DSH owns the agent loop and context. A live test streamed reasoning/text, used DSH's own `read` tool without emitting a Prime tool call, and recalled the tool result on the next turn from the same DSH session.
