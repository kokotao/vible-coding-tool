/**
 * @description QQ 长连接桥接器 CLI 包装器
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-30 10:45
 */
import { startQqWsBridge } from "../src/modules/qq/qq-ws-bridge";

async function main() {
  const handle = await startQqWsBridge({
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
  console.error("[qq-ws] fatal:", error);
  process.exit(1);
});
