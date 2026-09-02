---
name: deepseek-harness
summary: Delegate a task to the real DeepSeek Harness runtime through the prime-agent-dsh bridge.
description: Use when the user explicitly asks to use DeepSeek Harness, DSH, a DSH profile, or DSH-owned context/memory/plugins. Do not use merely because the selected model is made by DeepSeek.
---

# DeepSeek Harness bridge

Use the `deepseek_harness` tool to delegate work to the actual DeepSeek Harness runtime.

- Give the delegated runtime a self-contained prompt: Prime history is not silently copied into DSH.
- Same-branch follow-ups automatically reuse the latest DSH session; pass the returned session ID explicitly when ambiguity is possible.
- DSH owns its own event log, derived context, tools, compaction, skills, subagents, and installed memory plugins.
- The bridge is not a DeepSeek model provider and should not be invoked merely because a DeepSeek model is selected.
- Cancellation closes the DSH runtime because the current preview SDK has no per-turn cancellation RPC.
