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

export type ParsedIdentityBindingCommand = {
  displayName: string;
};

const SESSION_PATTERN = /#session:([a-zA-Z0-9_-]+)/;
const THREAD_ID_PATTERN = /线程\s*ID[：:]\s*([^\n，,]+)/i;
const THREAD_TAG_PATTERN = /#thread:([a-zA-Z0-9_-]+)/;
const TASK_CONTENT_PATTERN = /任务内容[：:]\s*([\s\S]+)/;
const IDENTITY_BIND_PATTERN = /^(?:#)?(?:绑定姓名|绑定名称|绑定昵称|姓名绑定|name)\s*[:：=]?\s*([\s\S]+)$/i;

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
  const rawSelector = (threadTagMatched?.[1] || threadIdMatched?.[1] || "").trim();
  const threadSelector = rawSelector.replace(/[；;。]+$/g, "").trim() || null;

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

export function parseFeishuIdentityBindingCommand(text: string): ParsedIdentityBindingCommand | null {
  const rawText = (text || "").trim();
  const matched = rawText.match(IDENTITY_BIND_PATTERN);

  if (!matched) {
    return null;
  }

  const displayName = (matched[1] || "").trim();
  if (!displayName) {
    return null;
  }

  return {
    displayName
  };
}
