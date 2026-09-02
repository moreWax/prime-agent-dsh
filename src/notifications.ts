import type { SessionNotification } from "@agentclientprotocol/sdk";

export function notificationSummary(notification: SessionNotification): string | undefined {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case "agent_message_chunk": return "DeepSeek Harness: writing response";
    case "agent_thought_chunk": return "DeepSeek Harness: reasoning";
    case "tool_call": return `DeepSeek Harness: ${update.title || update.name || "tool call"}`;
    case "tool_call_update": return `DeepSeek Harness: tool ${update.status || "update"}`;
    case "plan":
    case "plan_update": return "DeepSeek Harness: plan updated";
    case "usage_update": return "DeepSeek Harness: usage updated";
    case "compaction_update": return "DeepSeek Harness: context compacted";
    case "config_option_update": return "DeepSeek Harness: configuration updated";
    default: return undefined;
  }
}
