import { AppError } from "../../lib/errors";

export type ParsedQqCommand = {
  sessionId: string | null;
  newSession: boolean;
  prompt: string;
  threadSelector: string | null;
  sourcePlatform: "qq";
  senderId: string;
  platformMessageId: string | null;
};

const SESSION_PATTERN = /#session:([a-zA-Z0-9_-]+)/;
const THREAD_ID_PATTERN = /线程\s*ID[：:]\s*([^\n，,]+)/i;
const THREAD_TAG_PATTERN = /#thread:([a-zA-Z0-9_-]+)/;
const TASK_CONTENT_PATTERN = /任务内容[：:]\s*([\s\S]+)/;

export function isExplicitQqCommand(text: string) {
  const rawText = (text || "").trim();
  if (!rawText) {
    return false;
  }

  return Boolean(rawText.match(SESSION_PATTERN) || rawText.match(THREAD_ID_PATTERN) || rawText.match(THREAD_TAG_PATTERN));
}

export function parseQqCommand(input: {
  text: string;
  senderId: string;
  messageId?: string | null;
}): ParsedQqCommand {
  const rawText = (input.text || "").trim();
  const sessionMatched = rawText.match(SESSION_PATTERN);
  const threadIdMatched = rawText.match(THREAD_ID_PATTERN);
  const threadTagMatched = rawText.match(THREAD_TAG_PATTERN);
  const taskContentMatched = rawText.match(TASK_CONTENT_PATTERN);

  let prompt = taskContentMatched?.[1]?.trim() || "";
  if (!prompt) {
    prompt = rawText;
    if (sessionMatched) {
      prompt = prompt.replace(sessionMatched[0], "").trim();
    }
    if (threadTagMatched) {
      prompt = prompt.replace(threadTagMatched[0], "").trim();
    }
    if (threadIdMatched) {
      prompt = prompt.replace(threadIdMatched[0], "").trim();
    }
  }

  if (!prompt) {
    throw new AppError("EMPTY_COMMAND", 400, "Command content is empty");
  }

  const rawSelector = (threadTagMatched?.[1] || threadIdMatched?.[1] || "").trim();
  const threadSelector = rawSelector.replace(/[；;。]+$/g, "").trim() || null;

  return {
    sessionId: sessionMatched?.[1] || null,
    newSession: false,
    prompt,
    threadSelector,
    sourcePlatform: "qq",
    senderId: input.senderId,
    platformMessageId: input.messageId ?? null
  };
}

