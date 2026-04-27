/**
 * @description 飞书长连接事件桥接器 CLI 包装器
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-27 11:08
 */
import { startFeishuWsBridge } from "../src/modules/feishu/feishu-ws-bridge";

async function main() {
  const handle = await startFeishuWsBridge({
    gatewayUrl: process.env.GATEWAY_URL || "http://127.0.0.1:3000"
  });

  const shutdown = () => {
    void handle.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((error) => {
  console.error("[feishu-ws] fatal:", error);
  process.exit(1);
});
