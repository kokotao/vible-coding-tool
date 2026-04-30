import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "../lib/errors";
import { ConnectorConfigService } from "../modules/connectors/connector-config-service";
import { createQqValidationSignature, verifyQqEventSignature } from "../modules/qq/qq-security";
import { QqWebhookService } from "../modules/qq/qq-webhook-service";

type QqCallbackEnvelope = {
  id?: string;
  op?: number;
  t?: string;
  s?: number;
  d?: {
    id?: string;
    type?: number;
    scene?: string;
    chat_type?: number;
    user_openid?: string;
    group_member_openid?: string;
    content?: string;
    msg_id?: string;
    event_id?: string;
    group_openid?: string;
    data?: {
      type?: number;
      resolved?: {
        button_data?: string;
        button_id?: string;
        message_id?: string;
      };
    };
    author?: {
      id?: string;
      user_openid?: string;
      member_openid?: string;
    };
    plain_token?: string;
    event_ts?: string;
  };
};

type QqWebhookRequest = FastifyRequest<{ Body: QqCallbackEnvelope }> & {
  rawBody?: string;
};

function normalizeMessageText(content: string) {
  return (content || "")
    .replace(/<@!\d+>/g, "")
    .replace(/<@!\w+>/g, "")
    .trim();
}

function isQqMessageEventType(eventType: string) {
  return eventType === "C2C_MESSAGE_CREATE" || eventType === "GROUP_AT_MESSAGE_CREATE" || eventType === "GROUP_MSG_RECEIVE";
}

function isQqInteractionEventType(eventType: string) {
  return eventType === "INTERACTION_CREATE";
}

function normalizeHeaderValue(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function resolveRawBody(request: QqWebhookRequest) {
  if (typeof request.rawBody === "string") {
    return request.rawBody;
  }
  if (typeof request.body === "string") {
    return request.body;
  }
  if (request.body) {
    return JSON.stringify(request.body);
  }
  return "";
}

export function registerQqRoutes(
  app: FastifyInstance,
  qqWebhookService: QqWebhookService,
  connectorConfigService: ConnectorConfigService
) {
  app.register((qqScope, _opts, done) => {
    qqScope.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, callback) => {
      const rawBody = typeof body === "string" ? body : body.toString("utf8");
      (request as QqWebhookRequest).rawBody = rawBody;
      if (!rawBody.trim()) {
        callback(null, {});
        return;
      }
      try {
        callback(null, JSON.parse(rawBody));
      } catch {
        callback(new AppError("INVALID_JSON", 400, "Invalid JSON payload"));
      }
    });

    qqScope.post<{ Body: QqCallbackEnvelope }>("/api/qq/webhook", async (request) => {
      const qqRequest = request as QqWebhookRequest;
      const config = connectorConfigService.getConfig("qq");
      const secret = (config.appSecret || "").trim();
      const timestamp = normalizeHeaderValue(request.headers["x-signature-timestamp"]);
      const signature = normalizeHeaderValue(request.headers["x-signature-ed25519"]);
      const rawBody = resolveRawBody(qqRequest);
      if (secret) {
        if (!timestamp || !signature) {
          throw new AppError("QQ_VERIFY_FAILED", 401, "QQ callback signature headers missing");
        }
        const verified = verifyQqEventSignature({
          secret,
          timestamp,
          signature,
          rawBody
        });
        if (!verified) {
          throw new AppError("QQ_VERIFY_FAILED", 401, "QQ callback signature invalid");
        }
      }

      const payload = request.body || {};
      if (payload.op === 13) {
        const plainToken = (payload.d?.plain_token || "").trim();
        const eventTs = (payload.d?.event_ts || "").trim();
        if (!plainToken || !eventTs || !secret) {
          throw new AppError("QQ_VERIFY_FAILED", 401, "QQ callback challenge missing plain token or secret");
        }
        return {
          plain_token: plainToken,
          signature: createQqValidationSignature({
            secret,
            plainToken,
            eventTs
          })
        };
      }

      if (payload.op !== 0) {
        return {
          accepted: true,
          ignored: true,
          reason: "non_dispatch_event"
        };
      }

      const eventType = (payload.t || "").trim();
      if (!isQqMessageEventType(eventType) && !isQqInteractionEventType(eventType)) {
        return {
          accepted: true,
          ignored: true,
          reason: "unsupported_event_type"
        };
      }

      const senderId = String(
        payload.d?.author?.user_openid ||
          payload.d?.author?.member_openid ||
          payload.d?.author?.id ||
          payload.d?.group_member_openid ||
          payload.d?.user_openid ||
          ""
      ).trim();
      if (!senderId) {
        return {
          accepted: true,
          ignored: true,
          reason: "missing_sender"
        };
      }

      if (isQqInteractionEventType(eventType)) {
        const chatId = String(payload.d?.group_openid || "").trim() || null;
        const scene = String(payload.d?.scene || "").trim().toLowerCase();
        const isGroupInteraction = Boolean(chatId) || scene === "group" || payload.d?.chat_type === 1;
        return qqWebhookService.handleInteraction({
          senderId,
          interactionId: payload.d?.id ? String(payload.d.id) : null,
          eventId: payload.id ? String(payload.id) : null,
          messageId: payload.d?.data?.resolved?.message_id ? String(payload.d.data.resolved.message_id) : null,
          buttonData: String(payload.d?.data?.resolved?.button_data || "").trim(),
          buttonId: payload.d?.data?.resolved?.button_id ? String(payload.d.data.resolved.button_id) : null,
          chatId: isGroupInteraction ? chatId : null,
          chatType: isGroupInteraction ? "group" : "p2p"
        });
      }

      const normalizedText = normalizeMessageText(String(payload.d?.content || ""));
      if (!normalizedText) {
        return {
          accepted: true,
          ignored: true,
          reason: "empty_message"
        };
      }

      const isGroupMessage = eventType === "GROUP_AT_MESSAGE_CREATE" || eventType === "GROUP_MSG_RECEIVE";
      return qqWebhookService.handleIncomingMessage({
        senderId,
        messageId: payload.d?.id ? String(payload.d.id) : null,
        eventId: payload.id ? String(payload.id) : null,
        text: normalizedText,
        chatId: isGroupMessage ? String(payload.d?.group_openid || "").trim() || null : null,
        chatType: isGroupMessage ? "group" : "p2p",
        mentioned: eventType === "GROUP_AT_MESSAGE_CREATE",
        rawMessageId: payload.d?.id ? String(payload.d.id) : null,
        rawEventId: payload.id ? String(payload.id) : null
      });
    });

    done();
  });
}
