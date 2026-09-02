# DSH → Prime baseline bundle

This bundle uses DSH's stock `@deepseek-ai/dsh-subagent-acp` provider to launch
`prime-agent --mode acp`. It adds a `prime_subagent` tool to a base-backed DSH
profile. Each call is an isolated, one-shot Prime session; permissions default
to rejection and Prime session persistence is disabled.

Install into a base-backed profile with an application, such as `web`. In a source checkout:

```bash
dsh plugin --profile web add /absolute/path/to/prime-agent-dsh/dsh
```

A newly-created custom profile defaults to the base bundle only; add a Web, ACP,
or other application bundle if that profile must be directly launched.

For production, replace `command: prime-agent` with an absolute executable path
in the profile override and explicitly allowlist only required environment
variables. This baseline intentionally does not provide remote continuation,
Prime RPC UI, or inherited DSH context.
