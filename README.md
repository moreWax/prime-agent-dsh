# prime-agent-dsh

A self-contained [Prime Agent package](https://github.com/PrimeIntellect-ai/prime-agent) that delegates work to the **real [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** runtime.

This is **not** a DeepSeek model-provider plugin. The Prime extension launches `dsh --profile acp` and drives it with the standard Agent Client Protocol. The included DSH bundle uses DSH's stock ACP subagent provider to launch `prime-agent --mode acp` in the reverse direction. DeepSeek Harness remains responsible for its own agent loop, append-only session log, context projection, compaction, tools, skills, subagents, Cordis plugins, and optional memory plugins.

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

The tool returns a DSH session ID. On the same Prime branch, later calls automatically continue the latest DSH session; callers may also pass the ID explicitly. Forking before a DSH result mints a separate DSH session.

## Upgrade from v0.0.1

v0.0.2 replaces the narrow DSH SDK transport with ACP. Old caller-minted `prime-…` session identifiers are migrated to a fresh ACP session on first use; their old SDK history is not imported. New ACP-assigned IDs resume normally.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PRIME_DSH_PROFILE` | `acp` | Compatibility setting; the Prime bridge currently enforces the ACP profile |
| `PRIME_DSH_PROVIDER` | `deepseek-official` | DSH model-provider route |
| `PRIME_DSH_MODEL` | `deepseek-v4-flash` | DSH model route |
| `PRIME_DSH_HOME` | `~/.prime/agent/deepseek-harness` | Isolated DSH home and persistence |
| `PRIME_DSH_PATCHES` | empty | Comma/semicolon-separated Cordis patch paths |
| `PRIME_DSH_BIN` | package-pinned DSH CLI | Optional explicit compatible `dsh` executable |
| `PRIME_DSH_INITIALIZE_TIMEOUT_MS` | `15000` | Initialize handshake timeout |

The equivalent CLI flags `--dsh-bin` and `--dsh-home` override those two paths.

DSH credentials and provider setup are DSH concerns. Configure them in the isolated `DSH_HOME`, or pass only the provider credentials that the selected DSH adapter needs to the Prime process.

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

## Security and limitations

- DSH is a nested code-executing agent. Its full base-backed ACP profile currently defaults to workspace-write, but Cordis patches and third-party plugins are trusted code and can change the security boundary.
- Prime's tool approvals do not automatically become per-tool DSH approvals.
- Patch paths are operator configuration only; the model-facing tool cannot choose arbitrary patches, profiles, binaries, environment variables, or working directories.
- ACP cancellation is forwarded through `session/cancel`. The subprocess is closed only during bridge shutdown or if the transport fails.
- One ACP subprocess is reused per workspace/configuration. Calls on it are serialized.
- ACP `session/prompt` settles after the DSH agent reaches its defined terminal boundary; calls are serialized conservatively by the bridge.
- `stdout` belongs exclusively to ACP JSON-RPC. Never install a DSH plugin that writes arbitrary output to stdout in the ACP profile.

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
