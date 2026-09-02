import type { HarnessNotification } from "@deepseek-ai/dsh-sdk-client";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

export function notificationSummary(notification: HarnessNotification): string | undefined {
  if (notification.method === "session.status") {
    const status = notification.params.status;
    return typeof status === "string" ? `DeepSeek Harness: ${status}` : undefined;
  }
  if (notification.method === "subagent.started") return "DeepSeek Harness: subagent started";
  if (notification.method === "subagent.finished") return "DeepSeek Harness: subagent finished";
  if (notification.method !== "session.event") return undefined;
  const event = record(notification.params.event);
  if (!event || typeof event.type !== "string") return undefined;
  switch (event.type) {
    case "step/start": return "DeepSeek Harness: model step started";
    case "tool/call": {
      const data = record(event.data);
      const call = record(data?.call);
      const name = call?.name;
      return `DeepSeek Harness: tool${typeof name === "string" ? ` ${name}` : ""}`;
    }
    case "assistant/message": return "DeepSeek Harness: response committed";
    case "turn/end": return "DeepSeek Harness: turn ended";
    default: return undefined;
  }
}
