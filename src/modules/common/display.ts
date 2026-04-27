import type { MessageRecord } from "../../storage/repositories/message-repository";
import type { TaskRecord } from "../../storage/repositories/task-repository";

export function summarizeText(text: string | null | undefined, maxLength = 120) {
  const normalized = (text ?? "").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

export function deriveTaskTitle(task: TaskRecord, messages: MessageRecord[]) {
  const triggerMessage = messages.find((message) => message.eventId === task.triggerMessageId);

  if (triggerMessage?.content) {
    return summarizeText(triggerMessage.content, 80);
  }

  const firstCommand = messages.find((message) => message.messageType === "command");
  if (firstCommand?.content) {
    return summarizeText(firstCommand.content, 80);
  }

  if (task.summary) {
    return summarizeText(task.summary, 80);
  }

  return null;
}

export function startOfTodayIso() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.toISOString();
}
