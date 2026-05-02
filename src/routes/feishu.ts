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
import { FeishuFileService } from "../modules/feishu/feishu-file-service";
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

function decodeFeishuFilePayload(raw: string | undefined) {
  if (!raw) {
    return {
      fileKey: null,
      fileName: null
    };
  }

  try {
    const parsed = JSON.parse(raw) as {
      file_key?: string;
      file_name?: string;
    };
    const fileKey = String(parsed.file_key || "").trim() || null;
    const fileName = String(parsed.file_name || "").trim() || null;
    return {
      fileKey,
      fileName
    };
  } catch {
    return {
      fileKey: null,
      fileName: null
    };
  }
}

function decodeFeishuPostPayload(raw: string | undefined) {
  const fallback = {
    text: "",
    imageKeys: [] as string[],
    hasMentionTag: false
  };
  if (!raw) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const postRoot = resolveFeishuPostRoot(parsed);
    const locale = resolvePostLocaleBlock(postRoot);
    const sections = locale?.content || [];
    const texts: string[] = [];
    const imageKeys: string[] = [];
    let hasMentionTag = false;

    const title = String(locale?.title || "").trim();
    if (title) {
      texts.push(title);
    }

    for (const line of sections) {
      for (const item of line || []) {
        const tag = String(item.tag || "").trim().toLowerCase();
        if (tag === "text") {
          const text = String(item.text || "").trim();
          if (text) {
            texts.push(text);
          }
        } else if (tag === "img" || item.image_key) {
          const key = String(item.image_key || "").trim();
          if (key) {
            imageKeys.push(key);
          }
        } else if (tag === "at") {
          hasMentionTag = true;
        }
      }
    }

    const deepExtracted = extractPostRichElements(postRoot);
    for (const text of deepExtracted.texts) {
      texts.push(text);
    }
    for (const key of deepExtracted.imageKeys) {
      imageKeys.push(key);
    }
    hasMentionTag = hasMentionTag || deepExtracted.hasMentionTag;

    return {
      text: dedupeTexts(texts).join("\n").trim(),
      imageKeys: dedupeTexts(imageKeys),
      hasMentionTag
    };
  } catch {
    return fallback;
  }
}

type FeishuPostLocaleBlock = {
  title?: string;
  content?: Array<Array<{ tag?: string; text?: string; image_key?: string; user_id?: string }>>;
};

function resolvePostLocaleBlock(root: Record<string, unknown>): FeishuPostLocaleBlock | null {
  const preferredLocaleKeys = ["zh_cn", "en_us", "ja_jp"];
  for (const key of preferredLocaleKeys) {
    const block = toPostLocaleBlock(root[key]);
    if (block) {
      return block;
    }
  }

  for (const value of Object.values(root)) {
    const block = toPostLocaleBlock(value);
    if (block) {
      return block;
    }
  }
  return null;
}

function toPostLocaleBlock(value: unknown): FeishuPostLocaleBlock | null {
  if (!isRecord(value)) {
    return null;
  }

  const content = value.content;
  if (!Array.isArray(content)) {
    return null;
  }

  const normalizedContent = content
    .map((line) => {
      if (!Array.isArray(line)) {
        return [] as Array<{ tag?: string; text?: string; image_key?: string; user_id?: string }>;
      }
      return line
        .filter(isRecord)
        .map((item) => ({
          tag: typeof item.tag === "string" ? item.tag : undefined,
          text: typeof item.text === "string" ? item.text : undefined,
          image_key: typeof item.image_key === "string" ? item.image_key : undefined,
          user_id: typeof item.user_id === "string" ? item.user_id : undefined
        }));
    })
    .filter((line) => line.length > 0);

  return {
    title: typeof value.title === "string" ? value.title : undefined,
    content: normalizedContent
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resolveFeishuPostRoot(parsed: Record<string, unknown>) {
  const directPost = parseJsonLikeValue(parsed.post);
  if (isRecord(directPost)) {
    return directPost;
  }

  const nestedContent = parseJsonLikeValue(parsed.content);
  if (isRecord(nestedContent)) {
    const nestedPost = parseJsonLikeValue(nestedContent.post);
    if (isRecord(nestedPost)) {
      return nestedPost;
    }
    return nestedContent;
  }

  return parsed;
}

function parseJsonLikeValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const text = value.trim();
  if (!text || (text[0] !== "{" && text[0] !== "[")) {
    return value;
  }

  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function extractPostRichElements(root: unknown) {
  const texts: string[] = [];
  const imageKeys: string[] = [];
  let hasMentionTag = false;
  const visited = new Set<unknown>();

  const walk = (value: unknown, depth: number) => {
    if (depth > 10 || value === null || value === undefined) {
      return;
    }

    const parsed = parseJsonLikeValue(value);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        walk(item, depth + 1);
      }
      return;
    }

    if (!isRecord(parsed)) {
      return;
    }

    if (visited.has(parsed)) {
      return;
    }
    visited.add(parsed);

    const tag = typeof parsed.tag === "string" ? parsed.tag.trim().toLowerCase() : "";
    const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    const imageKey =
      typeof parsed.image_key === "string"
        ? parsed.image_key.trim()
        : typeof parsed.imageKey === "string"
          ? parsed.imageKey.trim()
          : "";

    if (tag === "at" || /<at\b/i.test(text)) {
      hasMentionTag = true;
    }
    if (tag === "text" && text) {
      texts.push(text);
    }
    if (title) {
      texts.push(title);
    }
    if (imageKey) {
      imageKeys.push(imageKey);
    }

    for (const item of Object.values(parsed)) {
      walk(item, depth + 1);
    }
  };

  walk(root, 0);
  return {
    texts: dedupeTexts(texts),
    imageKeys: dedupeTexts(imageKeys),
    hasMentionTag
  };
}

function dedupeTexts(items: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const value = String(item || "").trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
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

function buildFilePrompt(input: {
  fileKey: string;
  fileName: string | null;
  savedPath: string | null;
  messageText: string;
  downloadError: string | null;
}) {
  const taskText = input.messageText.trim() || "请阅读该文件并给出摘要与关键结论。";
  const fileNameLine = input.fileName ? `文件名：${input.fileName}` : "文件名：未知";
  const fileLine = input.savedPath ? `文件本地路径：${input.savedPath}` : `文件标识：${input.fileKey}`;
  const errorLine = input.downloadError ? `文件下载状态：${input.downloadError}` : "文件下载状态：成功";
  return `${taskText}\n\n[文件输入]\n${fileNameLine}\n${fileLine}\n${errorLine}`;
}

function buildPostPrompt(input: {
  messageText: string;
  imagePaths: string[];
  imageKeys: string[];
  downloadErrors: string[];
}) {
  const taskText = input.messageText.trim() || "请基于这条富文本消息内容完成分析。";
  const imagePathLines =
    input.imagePaths.length > 0
      ? input.imagePaths.map((item, index) => `${index + 1}. ${item}`).join("\n")
      : "无";
  const imageKeyLines =
    input.imageKeys.length > 0
      ? input.imageKeys.map((item, index) => `${index + 1}. ${item}`).join("\n")
      : "无";
  const errorLines =
    input.downloadErrors.length > 0 ? input.downloadErrors.map((item, index) => `${index + 1}. ${item}`).join("\n") : "无";

  return `${taskText}\n\n[富文本输入]\n图片本地路径列表：\n${imagePathLines}\n图片标识列表：\n${imageKeyLines}\n图片下载异常：\n${errorLines}`;
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
  feishuFileService: FeishuFileService,
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
      event.message?.message_type !== "image" &&
      event.message?.message_type !== "file" &&
      event.message?.message_type !== "post"
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
    const isFileMessage = message.message_type === "file";
    const isPostMessage = message.message_type === "post";
    const imageKey = isImageMessage ? decodeFeishuImageKey(message.content) : null;
    const filePayload = isFileMessage ? decodeFeishuFilePayload(message.content) : { fileKey: null, fileName: null };
    const postPayload = isPostMessage ? decodeFeishuPostPayload(message.content) : { text: "", imageKeys: [], hasMentionTag: false };
    let imagePath: string | null = null;
    let imageDownloadError: string | null = null;
    let filePath: string | null = null;
    let fileDownloadError: string | null = null;
    const postImagePaths: string[] = [];
    const postImageDownloadErrors: string[] = [];

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

    if (isFileMessage && filePayload.fileKey) {
      try {
        const downloaded = await feishuFileService.downloadFileByKey({
          fileKey: filePayload.fileKey,
          fileName: filePayload.fileName,
          messageId: message.message_id ?? null
        });
        filePath = downloaded.savedPath;
      } catch (error) {
        fileDownloadError = error instanceof Error ? error.message : String(error);
      }
    }

    if (isFileMessage && !filePayload.fileKey) {
      return {
        accepted: true,
        ignored: true,
        reason: "missing_file_key"
      };
    }

    if (isPostMessage && postPayload.imageKeys.length > 0) {
      for (const key of postPayload.imageKeys) {
        try {
          const downloaded = await feishuImageService.downloadImageByKey({
            imageKey: key,
            messageId: message.message_id ?? null
          });
          postImagePaths.push(downloaded.savedPath);
        } catch (error) {
          postImageDownloadErrors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }

    const normalizedText = isImageMessage
      ? buildImagePrompt({
          imageKey: imageKey!,
          savedPath: imagePath,
          messageText: decoded.text,
          downloadError: imageDownloadError
        })
      : isFileMessage
        ? buildFilePrompt({
            fileKey: filePayload.fileKey!,
            fileName: filePayload.fileName,
            savedPath: filePath,
            messageText: decoded.text,
            downloadError: fileDownloadError
          })
        : isPostMessage
          ? buildPostPrompt({
              messageText: postPayload.text,
              imagePaths: postImagePaths,
              imageKeys: postPayload.imageKeys,
              downloadErrors: postImageDownloadErrors
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
    const mentioned =
      mentionOpenIds.length > 0 || decoded.hasMentionTag || postPayload.hasMentionTag || /^\s*@\S+/.test(decoded.text);
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
      allowImplicitDispatch: isImageMessage || isFileMessage || isPostMessage
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
