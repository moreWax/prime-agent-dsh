---
name: deepseek-harness
description: Use when the user explicitly asks to use DeepSeek Harness, DSH, a DSH profile, or DSH-owned context/memory/plugins. Do not use merely because the selected model is made by DeepSeek.
---

# DeepSeek Harness bridge

Use the `deepseek_harness` tool to delegate work to the actual DeepSeek Harness runtime.

- Give the delegated runtime a self-contained prompt: Prime history is not silently copied into DSH.
- Same-branch follow-ups automatically reuse the latest DSH session; pass the returned session ID explicitly when ambiguity is possible.
- DSH owns its own event log, derived context, tools, compaction, skills, subagents, and installed memory plugins.
- The bridge is not a DeepSeek model provider and should not be invoked merely because a DeepSeek model is selected.
- Cancellation is forwarded cooperatively through ACP `session/cancel`; process shutdown is the fallback boundary.

- Inference uses Prime Agent's currently selected model and Prime-resolved authentication; DSH does not select a DeepSeek model by default.
