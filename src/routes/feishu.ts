/**
 * @description 飞书 webhook 路由，负责 challenge 回应与文本消息入站分发
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-26 09:26
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { FeishuDirectoryService } from "../modules/feishu/feishu-directory-service";
import { FeishuImageService } from "../modules/feishu/feishu-image-service";
import { decryptFeishuPayloadIfNeeded, verifyFeishuEventSignature } from "../modules/feishu/feishu-security";
import { FeishuWebhookService } from "../modules/feishu/feishu-webhook-service";

type FeishuWebhookBody = {
  token?: string;
  type?: string;
  schema?: string;
  challenge?: string;
  header?: {
    event_id?: string;
    event_type?: string;
    token?: string;
  };
  event?: {
    type?: string;
    message?: {
      message_id?: string;
      message_type?: string;
      content?: string;
      chat_id?: string;
      chat_type?: string;
      mentions?: Array<{
        id?: {
          open_id?: string;
          user_id?: string;
          union_id?: string;
        };
        key?: string;
        name?: string;
      }>;
    };
    action?: {
      tag?: string;
      value?: unknown;
      name?: string;
      option?: string;
    };
    context?: {
      open_message_id?: string;
      open_chat_id?: string;
    };
    operator?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
      name?: string;
    };
    sender?: {
      sender_id?: {
        open_id?: string;
        union_id?: string;
        user_id?: string;
      };
    };
  };
};

const recentOpenIdsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional()
});

const sendMessageSchema = z.object({
  openId: z.string().min(1),
  text: z.string().min(1).max(4000),
  actorId: z.string().min(1).optional()
});

function decodeFeishuMessageContent(raw: string | undefined) {
  const fallback = {
    text: "",
    hasMentionTag: false,
    mentionOpenIds: [] as string[]
  };

  if (!raw) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(raw) as {
      text?: string;
      mentions?: Array<{
        id?: {
          open_id?: string;
          user_id?: string;
          union_id?: string;
        };
      }>;
    };
    const mentionOpenIds = (parsed.mentions || [])
      .map((item) => item.id?.open_id || item.id?.user_id || item.id?.union_id || "")
      .map((value) => value.trim())
      .filter(Boolean);

    return {
      text: stripFeishuMentions(parsed.text ?? ""),
      hasMentionTag: /<at\b/i.test(parsed.text ?? ""),
      mentionOpenIds
    };
  } catch {
    const looseText = extractLooseTextField(raw);
    if (!looseText) {
      return fallback;
    }

    return {
      text: stripFeishuMentions(looseText),
      hasMentionTag: /<at\b/i.test(looseText),
      mentionOpenIds: [] as string[]
    };
  }
}

function extractLooseTextField(raw: string) {
  const marker = "\"text\":\"";
  const start = raw.indexOf(marker);
  if (start < 0) {
    return "";
  }

  let index = start + marker.length;
  let escaped = false;
  let buffer = "";
  while (index < raw.length) {
    const char = raw[index];
    if (!escaped && char === "\"") {
      break;
    }

    if (!escaped && char === "\\") {
      escaped = true;
      buffer += char;
      index += 1;
      continue;
    }

    escaped = false;
    buffer += char;
    index += 1;
  }

  return buffer.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
}

function decodeFeishuImageKey(raw: string | undefined) {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { image_key?: string };
    const imageKey = String(parsed.image_key || "").trim();
    return imageKey || null;
  } catch {
    return null;
  }
}

function buildImagePrompt(input: {
  imageKey: string;
  savedPath: string | null;
  messageText: string;
  downloadError: string | null;
}) {
  const taskText = input.messageText.trim() || "请分析这张图片并输出关键结论。";
  const imageLine = input.savedPath
    ? `图片本地路径：${input.savedPath}`
    : `图片标识：${input.imageKey}（未能下载到本地）`;
  const errorLine = input.downloadError ? `图片下载状态：${input.downloadError}` : "图片下载状态：成功";

  return `${taskText}\n\n[图片输入]\n${imageLine}\n${errorLine}`;
}

function stripFeishuMentions(text: string) {
  if (!text) {
    return "";
  }

  const removedAtTags = text
    .replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, " ")
    .replace(/<at\b[^>]*\/>/gi, " ");
  let remaining = removedAtTags.trim();

  for (let index = 0; index < 5; index += 1) {
    const matched = remaining.match(/^@([^\s:：,，;；、]+)(?:[\s:：,，;；、]+)([\s\S]*)$/u);
    if (!matched) {
      break;
    }
    remaining = matched[2].trimStart();
  }

  return remaining.trim();
}

function verifyFeishuToken(
  verifyToken: string | undefined,
  tokenHeader: string | undefined,
  bodyToken: string | undefined
) {
  if (!verifyToken) {
    return;
  }

  const received = tokenHeader || bodyToken;

  if (verifyToken !== received) {
    throw new AppError("FEISHU_VERIFY_FAILED", 401, "Feishu verify token mismatch");
  }
}

function normalizeFeishuEvent(body: FeishuWebhookBody) {
  if (body.schema === "2.0") {
    return {
      eventType: body.header?.event_type ?? "",
      eventId: body.header?.event_id ?? null,
      token: body.header?.token ?? body.token,
      event: body.event
    };
  }

  return {
    eventType: body.event?.type ?? "",
    eventId: null,
    token: body.token,
    event: body.event
  };
}

export function registerFeishuRoutes(
  app: FastifyInstance,
  feishuWebhookService: FeishuWebhookService,
  feishuDirectoryService: FeishuDirectoryService,
  feishuImageService: FeishuImageService,
  verifyToken: string | undefined,
  encryptKey: string | undefined
) {
  app.post<{ Body: FeishuWebhookBody }>("/api/feishu/webhook", async (request) => {
    const payload = decryptFeishuPayloadIfNeeded(request.body, encryptKey) as FeishuWebhookBody;

    if (payload.challenge || payload.type === "url_verification") {
      verifyFeishuToken(
        verifyToken,
        request.headers["x-lark-request-token"] as string | undefined,
        payload.token
      );
      return {
        challenge: payload.challenge
      };
    }

    verifyFeishuEventSignature(encryptKey, request.headers as Record<string, unknown>, request.body);
    const normalized = normalizeFeishuEvent(payload);

    verifyFeishuToken(
      verifyToken,
      request.headers["x-lark-request-token"] as string | undefined,
      normalized.token
    );

    const event = normalized.event;
    if (!event || (normalized.eventType !== "im.message.receive_v1" && normalized.eventType !== "card.action.trigger")) {
      return {
        accepted: true,
        ignored: true
      };
    }

    if (
      normalized.eventType === "im.message.receive_v1" &&
      event.message?.message_type !== "text" &&
      event.message?.message_type !== "image"
    ) {
      return {
        accepted: true,
        ignored: true,
        reason: "unsupported_message_type"
      };
    }

    if (normalized.eventType === "card.action.trigger") {
      const senderId = event.operator?.open_id || event.operator?.user_id || event.operator?.union_id || "unknown_sender";
      return feishuWebhookService.handleCardAction({
        senderId,
        messageId: event.context?.open_message_id ?? null,
        eventId: normalized.eventId,
        action: event.action ?? null,
        context: event.context ?? null
      });
    }

    const message = event.message;
    if (!message) {
      return {
        accepted: true,
        ignored: true,
        reason: "missing_message_payload"
      };
    }

    const decoded = decodeFeishuMessageContent(message.content);
    const isImageMessage = message.message_type === "image";
    const imageKey = isImageMessage ? decodeFeishuImageKey(message.content) : null;
    let imagePath: string | null = null;
    let imageDownloadError: string | null = null;

    if (isImageMessage && imageKey) {
      try {
        const downloaded = await feishuImageService.downloadImageByKey({
          imageKey,
          messageId: message.message_id ?? null
        });
        imagePath = downloaded.savedPath;
      } catch (error) {
        imageDownloadError = error instanceof Error ? error.message : String(error);
      }
    }

    if (isImageMessage && !imageKey) {
      return {
        accepted: true,
        ignored: true,
        reason: "missing_image_key"
      };
    }

    const normalizedText = isImageMessage
      ? buildImagePrompt({
          imageKey: imageKey!,
          savedPath: imagePath,
          messageText: decoded.text,
          downloadError: imageDownloadError
        })
      : decoded.text;
    const openChatId = message.chat_id || event.context?.open_chat_id || null;
    const chatType = (message.chat_type || "").trim().toLowerCase() || null;
    const mentionOpenIds = [
      ...decoded.mentionOpenIds,
      ...((message.mentions || [])
        .map((item) => item.id?.open_id || item.id?.user_id || item.id?.union_id || "")
        .map((value) => value.trim())
        .filter(Boolean) as string[])
    ];
    const mentioned = mentionOpenIds.length > 0 || decoded.hasMentionTag || /^\s*@\S+/.test(decoded.text);
    const senderId =
      event.sender?.sender_id?.open_id ||
      event.sender?.sender_id?.user_id ||
      event.sender?.sender_id?.union_id ||
      "unknown_sender";

    return feishuWebhookService.handleIncomingMessage({
      senderId,
      messageId: message.message_id ?? null,
      eventId: normalized.eventId,
      text: normalizedText,
      chatId: openChatId,
      chatType: chatType === "group" || chatType === "p2p" ? chatType : null,
      mentioned,
      allowImplicitDispatch: isImageMessage
    });
  });

  app.get<{ Querystring: { limit?: string } }>("/api/feishu/open-ids/recent", async (request) => {
    const query = recentOpenIdsQuerySchema.parse(request.query);
    return feishuDirectoryService.getRecentOpenIds(query.limit ?? 20);
  });

  app.post<{ Body: unknown }>("/api/feishu/messages/send", async (request) => {
    const payload = sendMessageSchema.parse(request.body);
    return feishuDirectoryService.sendMessageToOpenId(payload);
  });
}
