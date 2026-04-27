/**
 * @description 飞书长连接事件桥接器，接收 SDK 事件并转发到本地网关 /api/feishu/webhook
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-26 14:49
 */
import * as Lark from "@larksuiteoapi/node-sdk";

type FeishuConnectorConfig = {
  appId: string;
  appSecret: string;
};

const GATEWAY_URL = (process.env.GATEWAY_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const FEISHU_VERIFY_TOKEN = (process.env.FEISHU_VERIFY_TOKEN || "").trim();

async function main() {
  const { appId, appSecret } = await resolveCredentials();
  await ensureGatewayReady();

  const wsClient = new Lark.WSClient({
    appId,
    appSecret,
    loggerLevel: Lark.LoggerLevel.info,
    onReady: () => {
      console.log("[feishu-ws] connected");
    },
    onReconnecting: () => {
      console.log("[feishu-ws] reconnecting...");
    },
    onReconnected: () => {
      console.log("[feishu-ws] reconnected");
    },
    onError: (error) => {
      console.error("[feishu-ws] connection failed:", error.message);
    }
  });

  const dispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (event: Record<string, unknown>) => {
      await forwardMessageEvent(event);
    }
  });

  await wsClient.start({ eventDispatcher: dispatcher });
  console.log("[feishu-ws] listening events: im.message.receive_v1");
  console.log("[feishu-ws] keep this process running, then click '重新验证' in Feishu console.");

  const shutdown = () => {
    console.log("[feishu-ws] shutting down...");
    wsClient.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function resolveCredentials(): Promise<FeishuConnectorConfig> {
  const envAppId = (process.env.FEISHU_APP_ID || "").trim();
  const envAppSecret = (process.env.FEISHU_APP_SECRET || "").trim();

  if (envAppId && envAppSecret) {
    return {
      appId: envAppId,
      appSecret: envAppSecret
    };
  }

  const response = await fetch(`${GATEWAY_URL}/api/connectors/feishu/config`);
  if (!response.ok) {
    throw new Error(`failed to load connector config from gateway: status=${response.status}`);
  }

  const payload = (await response.json()) as Partial<FeishuConnectorConfig>;
  const appId = String(payload.appId || "").trim();
  const appSecret = String(payload.appSecret || "").trim();

  if (!appId || !appSecret) {
    throw new Error(
      "missing FEISHU_APP_ID/FEISHU_APP_SECRET and connector config appId/appSecret is empty"
    );
  }

  return {
    appId,
    appSecret
  };
}

async function ensureGatewayReady() {
  const response = await fetch(`${GATEWAY_URL}/health`);
  if (!response.ok) {
    throw new Error(`gateway health check failed: status=${response.status}`);
  }
}

async function forwardMessageEvent(event: Record<string, unknown>) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  if (FEISHU_VERIFY_TOKEN) {
    headers["x-lark-request-token"] = FEISHU_VERIFY_TOKEN;
  }

  const body = {
    event: {
      type: "im.message.receive_v1",
      message: event.message,
      sender: event.sender
    }
  };

  const response = await fetch(`${GATEWAY_URL}/api/feishu/webhook`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  const responseText = await response.text();
  if (!response.ok) {
    console.error(
      `[feishu-ws] forward failed status=${response.status} body=${responseText || "<empty>"}`
    );
    return;
  }

  console.log(`[feishu-ws] forwarded event ok body=${responseText || "<empty>"}`);
}

void main().catch((error) => {
  console.error("[feishu-ws] fatal:", error);
  process.exit(1);
});
