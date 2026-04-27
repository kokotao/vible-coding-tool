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
  if (!raw) {
    return "";
  }

  try {
    const parsed = JSON.parse(raw) as { text?: string };
    return parsed.text ?? "";
  } catch {
    return "";
  }
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
    if (!event || normalized.eventType !== "im.message.receive_v1") {
      return {
        accepted: true,
        ignored: true
      };
    }

    if (event.message?.message_type !== "text") {
      return {
        accepted: true,
        ignored: true,
        reason: "non_text_message"
      };
    }

    const text = decodeFeishuMessageContent(event.message.content);
    const senderId =
      event.sender?.sender_id?.open_id ||
      event.sender?.sender_id?.user_id ||
      event.sender?.sender_id?.union_id ||
      "unknown_sender";

    return feishuWebhookService.handleIncomingMessage({
      senderId,
      messageId: event.message.message_id ?? null,
      eventId: normalized.eventId,
      text
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
