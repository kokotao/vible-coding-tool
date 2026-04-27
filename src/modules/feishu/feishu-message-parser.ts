/**
 * @description 解析飞书文本消息中的 #session 指令与命令正文
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-26 09:26
 */
import { AppError } from "../../lib/errors";

export type ParsedCommand = {
  sessionId: string | null;
  prompt: string;
  threadAlias: string | null;
  threadSelector: string | null;
  sourcePlatform: "feishu";
  senderId: string;
  platformMessageId: string | null;
};

const SESSION_PATTERN = /#session:([a-zA-Z0-9_-]+)/;
const THREAD_ID_PATTERN = /线程\s*ID[：:]\s*([^\n，,]+)/i;
const THREAD_TAG_PATTERN = /#thread:([a-zA-Z0-9_-]+)/;
const TASK_CONTENT_PATTERN = /任务内容[：:]\s*([\s\S]+)/;

export function parseFeishuCommand(input: {
  text: string;
  senderId: string;
  messageId?: string | null;
}): ParsedCommand {
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

  const threadAlias = null;
  const threadSelector = (threadTagMatched?.[1] || threadIdMatched?.[1] || "").trim() || null;

  return {
    sessionId: sessionMatched?.[1] || null,
    prompt,
    threadAlias,
    threadSelector,
    sourcePlatform: "feishu",
    senderId: input.senderId,
    platformMessageId: input.messageId ?? null
  };
}
