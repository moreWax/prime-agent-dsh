# prime-agent-dsh

A self-contained [Prime Agent package](https://github.com/PrimeIntellect-ai/prime-agent) that delegates work to the **real [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** runtime.

This is **not** a DeepSeek model-provider plugin. It uses the official `@deepseek-ai/dsh-sdk-client`, which launches `dsh --profile sdk` and drives it over stdio JSON-RPC. DeepSeek Harness remains responsible for its own agent loop, append-only session log, context projection, compaction, tools, skills, subagents, Cordis plugins, and optional memory plugins.

> DeepSeek Harness is currently a developer preview and warns that breaking changes are expected. This package pins the DSH SDK/runtime version exactly.

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

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PRIME_DSH_PROFILE` | `sdk` | DSH profile serving the SDK protocol |
| `PRIME_DSH_PROVIDER` | `deepseek-official` | DSH model-provider route |
| `PRIME_DSH_MODEL` | `deepseek-v4-flash` | DSH model route |
| `PRIME_DSH_HOME` | `~/.prime/agent/deepseek-harness` | Isolated DSH home and persistence |
| `PRIME_DSH_PATCHES` | empty | Comma/semicolon-separated Cordis patch paths |
| `PRIME_DSH_BIN` | SDK's matching bundled CLI | Optional explicit compatible `dsh` executable |
| `PRIME_DSH_REASONING_EFFORT` | provider default | Adapter-owned effort ID |
| `PRIME_DSH_MAX_TOKENS` | provider default | Per-request output cap |
| `PRIME_DSH_INITIALIZE_TIMEOUT_MS` | `15000` | Initialize handshake timeout |
| `PRIME_DSH_REQUEST_TIMEOUT_MS` | unbounded | JSON-RPC request timeout |

The equivalent CLI flags `--dsh-bin` and `--dsh-home` override those two paths.

DSH credentials and provider setup are DSH concerns. Configure them in the isolated `DSH_HOME`, or pass only the provider credentials that the selected DSH adapter needs to the Prime process.

## Context and memory boundary

Prime and DSH intentionally keep separate histories:

1. Prime calls the bridge with a self-contained task.
2. The official SDK queues that task into a DSH session.
3. DSH logs it durably and derives future model context from its own event stream.
4. Follow-ups reuse the DSH session ID.
5. Prime receives the committed final response and bounded progress summaries.

The bridge does **not** replay Prime's complete transcript into DSH. Doing that would duplicate context and undermine DSH's invariant that model-visible inputs are reconstructable from its session log.

Memory behavior depends on the selected DSH profile and installed DSH plugins. The bridge preserves those features; it does not pretend every optional memory plugin is installed.

## Security and limitations

- DSH is a nested code-executing agent. Its `sdk` profile currently defaults to workspace-write, but Cordis patches and third-party plugins are trusted code and can change the security boundary.
- Prime's tool approvals do not automatically become per-tool DSH approvals.
- Patch paths are operator configuration only; the model-facing tool cannot choose arbitrary patches, profiles, binaries, environment variables, or working directories.
- The current DSH SDK has no per-turn cancellation method. Aborting the Prime tool closes the owned DSH runtime, which also loses live terminal state. Durable DSH history remains in `DSH_HOME`.
- One SDK subprocess is reused per workspace/configuration. Calls on it are serialized.
- The official SDK defines completion as the prompt's durable inbox receipt followed by the next whole-agent `idle`; it does not claim strict causal attribution when other work is queued.
- `stdout` belongs exclusively to DSH JSON-RPC. Never install a DSH plugin that writes arbitrary output to stdout in the SDK profile.

## Development

```bash
npm install
npm run check
```

Relevant upstream interfaces:

- `packages/sdk/client/README.md`
- `packages/sdk/protocol/README.md`
- `packages/bundle/sdk-app/README.md`
- `docs/architecture.md`

## License

MIT. DeepSeek Harness and its transitive dependencies retain their own licenses and notices.
