/**
 * @description 飞书长连接桥接器，负责启动 WSClient 并将消息转发到本地网关
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-27 11:08
 */
import * as Lark from "@larksuiteoapi/node-sdk";

type FeishuConnectorConfig = {
  appId?: string;
  appSecret?: string;
};

type FeishuBridgeLogger = Pick<Console, "info" | "warn" | "error" | "debug" | "trace">;

type FeishuMessageHandlers = {
  "im.message.receive_v1": (event: Record<string, unknown>) => Promise<void>;
  "card.action.trigger": (event: Record<string, unknown>) => Promise<void>;
};

type FeishuWsClientLike = {
  start(input: { eventDispatcher: unknown }): Promise<void>;
  close(): void;
};

type FeishuWsClientOptions = {
  appId: string;
  appSecret: string;
  loggerLevel: Lark.LoggerLevel;
  logger: FeishuBridgeLogger;
  onReady: () => void;
  onReconnecting: () => void;
  onReconnected: () => void;
  onError: (error: Error) => void;
};

type FeishuWsBridgeOptions = {
  gatewayUrl?: string;
  verifyToken?: string;
  fetchImpl?: typeof fetch;
  logger?: FeishuBridgeLogger;
  clientFactory?: (options: FeishuWsClientOptions) => FeishuWsClientLike;
  dispatcherFactory?: (handlers: FeishuMessageHandlers) => unknown;
};

export type FeishuWsBridgeHandle = {
  stop: () => Promise<void>;
};

export type FeishuWsBridgeDefaults = {
  autoStart: boolean;
};

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:3000";

export function resolveFeishuWsBridgeDefaults(): FeishuWsBridgeDefaults {
  return {
    autoStart: (process.env.FEISHU_WS_AUTO_START || "").trim()
      ? (process.env.FEISHU_WS_AUTO_START || "").trim() === "true"
      : process.env.NODE_ENV !== "test"
  };
}

export async function startFeishuWsBridge(options: FeishuWsBridgeOptions = {}): Promise<FeishuWsBridgeHandle> {
  const gatewayUrl = normalizeGatewayUrl(options.gatewayUrl ?? process.env.GATEWAY_URL ?? DEFAULT_GATEWAY_URL);
  const fetchImpl = options.fetchImpl ?? fetch;
  const logger = options.logger ?? console;
  const verifyToken = (options.verifyToken ?? process.env.FEISHU_VERIFY_TOKEN ?? "").trim();
  const { appId, appSecret } = await resolveCredentials(gatewayUrl, fetchImpl);

  await ensureGatewayReady(gatewayUrl, fetchImpl);

  const clientFactory = options.clientFactory ?? createDefaultClientFactory(logger);
  const dispatcherFactory = options.dispatcherFactory ?? createDefaultDispatcherFactory();
  const wsClient = clientFactory({
    appId,
    appSecret,
    loggerLevel: Lark.LoggerLevel.error,
    logger,
    onReady: () => {
      logger.info("[feishu-ws] connected");
    },
    onReconnecting: () => {
      logger.info("[feishu-ws] reconnecting...");
    },
    onReconnected: () => {
      logger.info("[feishu-ws] reconnected");
    },
    onError: (error) => {
      logger.error("[feishu-ws] connection failed:", error.message);
    }
  });

  const dispatcher = dispatcherFactory({
    "im.message.receive_v1": async (event: Record<string, unknown>) => {
      await forwardMessageEvent({
        gatewayUrl,
        fetchImpl,
        verifyToken,
        event,
        logger
      });
    },
    "card.action.trigger": async (event: Record<string, unknown>) => {
      await forwardCardActionEvent({
        gatewayUrl,
        fetchImpl,
        verifyToken,
        event,
        logger
      });
    }
  });

  await wsClient.start({ eventDispatcher: dispatcher });
  logger.info("[feishu-ws] listening events: im.message.receive_v1");
  logger.info("[feishu-ws] keep this process running, then click '重新验证' in Feishu console.");

  return {
    stop: async () => {
      logger.info("[feishu-ws] shutting down...");
      wsClient.close();
    }
  };
}

async function resolveCredentials(gatewayUrl: string, fetchImpl: typeof fetch) {
  const envAppId = (process.env.FEISHU_APP_ID || "").trim();
  const envAppSecret = (process.env.FEISHU_APP_SECRET || "").trim();

  if (envAppId && envAppSecret) {
    return {
      appId: envAppId,
      appSecret: envAppSecret
    };
  }

  const response = await fetchImpl(`${gatewayUrl}/api/connectors/feishu/config`);
  if (!response.ok) {
    throw new Error(`failed to load connector config from gateway: status=${response.status}`);
  }

  const payload = (await response.json()) as FeishuConnectorConfig;
  const appId = String(payload.appId || "").trim();
  const appSecret = String(payload.appSecret || "").trim();

  if (!appId || !appSecret) {
    throw new Error("missing FEISHU_APP_ID/FEISHU_APP_SECRET and connector config appId/appSecret is empty");
  }

  return {
    appId,
    appSecret
  };
}

async function ensureGatewayReady(gatewayUrl: string, fetchImpl: typeof fetch) {
  const response = await fetchImpl(`${gatewayUrl}/health`);
  if (!response.ok) {
    throw new Error(`gateway health check failed: status=${response.status}`);
  }
}

async function forwardMessageEvent(input: {
  gatewayUrl: string;
  fetchImpl: typeof fetch;
  verifyToken: string;
  event: Record<string, unknown>;
  logger: FeishuBridgeLogger;
}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  if (input.verifyToken) {
    headers["x-lark-request-token"] = input.verifyToken;
  }

  const body = {
    event: {
      type: "im.message.receive_v1",
      message: input.event.message,
      sender: input.event.sender
    }
  };

  const response = await input.fetchImpl(`${input.gatewayUrl}/api/feishu/webhook`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  const responseText = await response.text();
  if (!response.ok) {
    input.logger.error(
      `[feishu-ws] forward failed status=${response.status} body=${responseText || "<empty>"}`
    );
    return;
  }

  input.logger.info(`[feishu-ws] forwarded event ok body=${responseText || "<empty>"}`);
}

async function forwardCardActionEvent(input: {
  gatewayUrl: string;
  fetchImpl: typeof fetch;
  verifyToken: string;
  event: {
    context?: {
      open_message_id?: string;
      open_chat_id?: string;
    };
    operator?: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
      name?: string;
    };
    action?: {
      tag?: string;
      value?: unknown;
      name?: string;
      option?: string;
    };
    token?: string;
    open_message_id?: string;
    open_chat_id?: string;
  };
  logger: FeishuBridgeLogger;
}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  if (input.verifyToken) {
    headers["x-lark-request-token"] = input.verifyToken;
  }

  const body = {
    event: {
      type: "card.action.trigger",
      context: input.event.context,
      operator: input.event.operator,
      action: input.event.action,
      token: input.event.token,
      message: {
        message_id: input.event.open_message_id || input.event.context?.open_message_id,
        chat_id: input.event.open_chat_id || input.event.context?.open_chat_id
      }
    }
  };

  const response = await input.fetchImpl(`${input.gatewayUrl}/api/feishu/webhook`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  const responseText = await response.text();
  if (!response.ok) {
    input.logger.error(
      `[feishu-ws] forward card action failed status=${response.status} body=${responseText || "<empty>"}`
    );
    return;
  }

  input.logger.info(`[feishu-ws] forwarded card action ok body=${responseText || "<empty>"}`);
}

function createDefaultClientFactory(logger: FeishuBridgeLogger) {
  return (options: FeishuWsClientOptions) =>
    new Lark.WSClient({
      appId: options.appId,
      appSecret: options.appSecret,
      loggerLevel: options.loggerLevel,
      logger: options.logger,
      onReady: options.onReady,
      onReconnecting: options.onReconnecting,
      onReconnected: options.onReconnected,
      onError: options.onError
    }) as FeishuWsClientLike;
}

function createDefaultDispatcherFactory() {
  return (handlers: FeishuMessageHandlers) =>
    new Lark.EventDispatcher({
      loggerLevel: Lark.LoggerLevel.error
    }).register(handlers);
}

function normalizeGatewayUrl(value: string) {
  return value.replace(/\/+$/, "");
}
