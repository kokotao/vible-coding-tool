/**
 * @description QQ 长连接桥接器，负责连接 QQ Gateway WebSocket 并把消息事件转发回网关入站接口
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-30 10:45
 */
import { createQqRequestSignature } from "./qq-security";

type QqConnectorConfig = {
  appId?: string;
  appSecret?: string;
  eventMode?: "webhook" | "websocket";
  callbackUrl?: string;
};

type QqWsBridgeLogger = Pick<Console, "info" | "warn" | "error" | "debug">;

type QqWsBridgeOptions = {
  gatewayUrl?: string;
  fetchImpl?: typeof fetch;
  logger?: QqWsBridgeLogger;
  websocketFactory?: (url: string) => QqWsLike;
};

export type QqWsBridgeHandle = {
  active: boolean;
  stop: () => Promise<void>;
};

export type QqWsBridgeDefaults = {
  autoStart: boolean;
};

type QqWsLike = {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string | Buffer | Uint8Array | ArrayBuffer }) => void) | null;
  onerror: ((event: { error?: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

type QqGatewayPayload = {
  op: number;
  s?: number;
  t?: string;
  d?: unknown;
  id?: string;
};

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:3000";
const DEFAULT_OPEN_API_BASE_URL = "https://api.sgroup.qq.com";
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];

const QQ_INTENTS = {
  PUBLIC_GUILD_MESSAGES: 1 << 30,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C: 1 << 25,
  INTERACTION: 1 << 26
} as const;

const DEFAULT_INTENTS =
  QQ_INTENTS.PUBLIC_GUILD_MESSAGES | QQ_INTENTS.DIRECT_MESSAGE | QQ_INTENTS.GROUP_AND_C2C | QQ_INTENTS.INTERACTION;

const FORWARD_EVENT_TYPES = new Set(["C2C_MESSAGE_CREATE", "GROUP_AT_MESSAGE_CREATE", "GROUP_MESSAGE_CREATE"]);

export function resolveQqWsBridgeDefaults(): QqWsBridgeDefaults {
  return {
    autoStart: (process.env.QQ_WS_AUTO_START || "").trim()
      ? (process.env.QQ_WS_AUTO_START || "").trim() === "true"
      : process.env.NODE_ENV !== "test"
  };
}

export async function startQqWsBridge(options: QqWsBridgeOptions = {}): Promise<QqWsBridgeHandle> {
  const gatewayUrl = normalizeGatewayUrl(options.gatewayUrl ?? process.env.GATEWAY_URL ?? DEFAULT_GATEWAY_URL);
  const fetchImpl = options.fetchImpl ?? fetch;
  const logger = options.logger ?? console;
  const websocketFactory = options.websocketFactory ?? createDefaultWebSocketFactory();

  await ensureGatewayReady(gatewayUrl, fetchImpl);
  const connectorConfig = await loadConnectorConfig(gatewayUrl, fetchImpl);
  if (connectorConfig.eventMode !== "websocket") {
    logger.info("[qq-ws] skipped: qq connector eventMode is not websocket");
    return {
      active: false,
      stop: async () => {}
    };
  }

  const appId = String(connectorConfig.appId || "").trim();
  const appSecret = String(connectorConfig.appSecret || "").trim();
  if (!appId || !appSecret) {
    throw new Error("missing qq appId/appSecret in connector config");
  }

  const openApiBaseUrl = resolveOpenApiBaseUrl(connectorConfig.callbackUrl);
  let stopped = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let ws: QqWsLike | null = null;
  let sessionId: string | null = null;
  let lastSeq: number | null = null;

  const clearTimers = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const sendWsJson = (payload: Record<string, unknown>) => {
    if (!ws || ws.readyState !== 1) {
      return;
    }
    ws.send(JSON.stringify(payload));
  };

  const scheduleReconnect = () => {
    if (stopped) {
      return;
    }
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)];
    reconnectAttempts += 1;
    logger.warn(`[qq-ws] reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  };

  const forwardDispatchPayload = async (payload: QqGatewayPayload) => {
    const rawBody = JSON.stringify(payload);
    const timestamp = `${Math.floor(Date.now() / 1000)}`;
    const signature = createQqRequestSignature({
      secret: appSecret,
      timestamp,
      rawBody
    });

    const response = await fetchImpl(`${gatewayUrl}/api/qq/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-signature-timestamp": timestamp,
        "x-signature-ed25519": signature
      },
      body: rawBody
    });
    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      logger.error(
        `[qq-ws] forward failed status=${response.status} body=${responseText || "<empty>"} event=${payload.t || "unknown"}`
      );
      return;
    }

    logger.info(`[qq-ws] forwarded event ok type=${payload.t || "unknown"}`);
  };

  const handleGatewayPayload = async (payload: QqGatewayPayload, accessToken: string) => {
    if (typeof payload.s === "number") {
      lastSeq = payload.s;
    }

    if (payload.op === 10) {
      const heartbeatInterval = Number((payload.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval || 0);
      if (sessionId && lastSeq !== null) {
        sendWsJson({
          op: 6,
          d: {
            token: `QQBot ${accessToken}`,
            session_id: sessionId,
            seq: lastSeq
          }
        });
      } else {
        sendWsJson({
          op: 2,
          d: {
            token: `QQBot ${accessToken}`,
            intents: DEFAULT_INTENTS,
            shard: [0, 1]
          }
        });
      }

      if (heartbeatInterval > 0) {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }
        heartbeatTimer = setInterval(() => {
          sendWsJson({
            op: 1,
            d: lastSeq
          });
        }, heartbeatInterval);
      }
      return;
    }

    if (payload.op === 0) {
      if (payload.t === "READY") {
        const readySessionId = String((payload.d as { session_id?: string } | undefined)?.session_id || "").trim();
        if (readySessionId) {
          sessionId = readySessionId;
        }
        logger.info(`[qq-ws] ready session=${sessionId || "unknown"}`);
      } else if (payload.t === "RESUMED") {
        logger.info("[qq-ws] session resumed");
      } else if (payload.t && FORWARD_EVENT_TYPES.has(payload.t)) {
        await forwardDispatchPayload(payload);
      }
      return;
    }

    if (payload.op === 7) {
      logger.warn("[qq-ws] server requested reconnect");
      ws?.close();
      return;
    }

    if (payload.op === 9) {
      const canResume = payload.d === true;
      logger.warn(`[qq-ws] invalid session, canResume=${canResume}`);
      if (!canResume) {
        sessionId = null;
        lastSeq = null;
      }
      ws?.close();
    }
  };

  const connect = async () => {
    if (stopped) {
      return;
    }

    try {
      const accessToken = await requestAppAccessToken(fetchImpl, appId, appSecret);
      const gatewayWsUrl = await requestGatewayWsUrl(fetchImpl, openApiBaseUrl, accessToken);
      logger.info(`[qq-ws] connecting ${gatewayWsUrl}`);

      ws = websocketFactory(gatewayWsUrl);
      ws.onopen = () => {
        reconnectAttempts = 0;
        logger.info("[qq-ws] connected");
      };
      ws.onmessage = (event) => {
        void (async () => {
          try {
            const raw =
              typeof event.data === "string"
                ? event.data
                : Buffer.isBuffer(event.data)
                  ? event.data.toString("utf8")
                  : event.data instanceof Uint8Array
                    ? Buffer.from(event.data).toString("utf8")
                    : event.data instanceof ArrayBuffer
                      ? Buffer.from(event.data).toString("utf8")
                      : String(event.data || "");
            const payload = JSON.parse(raw) as QqGatewayPayload;
            await handleGatewayPayload(payload, accessToken);
          } catch (error) {
            logger.error(`[qq-ws] message parse/handle failed: ${String(error)}`);
          }
        })();
      };
      ws.onerror = (event) => {
        logger.error(`[qq-ws] websocket error: ${String(event.error || "unknown_error")}`);
      };
      ws.onclose = (event) => {
        logger.warn(`[qq-ws] disconnected code=${event.code ?? "unknown"} reason=${event.reason || ""}`);
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        ws = null;
        if (!stopped) {
          scheduleReconnect();
        }
      };
    } catch (error) {
      logger.error(`[qq-ws] connect failed: ${String(error)}`);
      scheduleReconnect();
    }
  };

  await connect();

  return {
    active: true,
    stop: async () => {
      stopped = true;
      clearTimers();
      ws?.close(1000, "manual_shutdown");
      ws = null;
      logger.info("[qq-ws] stopped");
    }
  };
}

async function ensureGatewayReady(gatewayUrl: string, fetchImpl: typeof fetch) {
  const response = await fetchImpl(`${gatewayUrl}/health`);
  if (!response.ok) {
    throw new Error(`gateway health check failed: status=${response.status}`);
  }
}

async function loadConnectorConfig(gatewayUrl: string, fetchImpl: typeof fetch): Promise<QqConnectorConfig> {
  const response = await fetchImpl(`${gatewayUrl}/api/connectors/qq/config`);
  if (!response.ok) {
    throw new Error(`failed to load qq connector config: status=${response.status}`);
  }

  return (await response.json()) as QqConnectorConfig;
}

async function requestAppAccessToken(fetchImpl: typeof fetch, appId: string, appSecret: string) {
  const response = await fetchImpl("https://bots.qq.com/app/getAppAccessToken", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      appId,
      clientSecret: appSecret
    })
  });
  const payload = (await response.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
  const accessToken = String(payload?.access_token || "").trim();
  if (!response.ok || !accessToken) {
    throw new Error(`qq token request failed: status=${response.status}`);
  }
  return accessToken;
}

async function requestGatewayWsUrl(fetchImpl: typeof fetch, openApiBaseUrl: string, accessToken: string) {
  const response = await fetchImpl(`${openApiBaseUrl}/gateway`, {
    method: "GET",
    headers: {
      Authorization: `QQBot ${accessToken}`
    }
  });
  const payload = (await response.json().catch(() => null)) as { url?: string } | null;
  const url = String(payload?.url || "").trim();
  if (!response.ok || !url) {
    throw new Error(`qq gateway url request failed: status=${response.status}`);
  }
  return url;
}

function createDefaultWebSocketFactory() {
  return (url: string) => {
    const WebSocketCtor = (globalThis as unknown as { WebSocket?: new (url: string) => QqWsLike }).WebSocket;
    if (!WebSocketCtor) {
      throw new Error("global WebSocket is not available in current runtime");
    }
    return new WebSocketCtor(url);
  };
}

function resolveOpenApiBaseUrl(rawValue: string | undefined) {
  const fallback = DEFAULT_OPEN_API_BASE_URL;
  const value = String(rawValue || "").trim();
  if (!value) {
    return fallback;
  }

  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
    const looksLikeGatewayWebhook = path.includes("/api/qq/webhook") || path.includes("/api/feishu/webhook");
    if (isLoopback || looksLikeGatewayWebhook) {
      return fallback;
    }
    return parsed.origin.replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

function normalizeGatewayUrl(value: string) {
  return value.replace(/\/+$/, "");
}
