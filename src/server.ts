import { buildApp } from "./app";
import { loadEnv } from "./config/env";
import {
  resolveCodexGlobalWatcherDefaults,
  startCodexGlobalWatcher,
  type CodexGlobalWatcherHandle
} from "./modules/codex/codex-global-watcher";
import {
  resolveFeishuWsBridgeDefaults,
  startFeishuWsBridge,
  type FeishuWsBridgeHandle
} from "./modules/feishu/feishu-ws-bridge";

async function main() {
  const env = loadEnv();
  const app = buildApp({ env });
  let watcherHandle: CodexGlobalWatcherHandle | null = null;
  let feishuBridgeHandle: FeishuWsBridgeHandle | null = null;
  const watcherDefaults = resolveCodexGlobalWatcherDefaults();
  const feishuBridgeDefaults = resolveFeishuWsBridgeDefaults();

  try {
    await app.listen({
      host: env.host,
      port: env.port
    });

    if (watcherDefaults.autoStart) {
      const gatewayUrl = `http://127.0.0.1:${env.port}`;
      try {
        watcherHandle = await startCodexGlobalWatcher({
          gatewayUrl,
          statePath: watcherDefaults.statePath,
          pollIntervalMs: watcherDefaults.pollIntervalMs,
          sessionId: watcherDefaults.sessionId,
          senderId: watcherDefaults.senderId,
          recipientOpenId: watcherDefaults.recipientOpenId,
          sessionsRoot: watcherDefaults.sessionsRoot,
          archivedSessionsRoot: watcherDefaults.archivedSessionsRoot,
          scanArchived: watcherDefaults.scanArchived,
          bootstrapMode: watcherDefaults.bootstrapMode,
          ingressToken: watcherDefaults.ingressToken,
          signingSecret: watcherDefaults.signingSecret
        });
        app.log.info(
          { gatewayUrl, sessionId: watcherDefaults.sessionId || null },
          "Codex global watcher started"
        );
      } catch (error) {
        app.log.error(error, "Failed to start Codex global watcher");
      }
    }

    if (env.feishuWsAutoStart && feishuBridgeDefaults.autoStart) {
      const gatewayUrl = `http://127.0.0.1:${env.port}`;
      try {
        feishuBridgeHandle = await startFeishuWsBridge({
          gatewayUrl,
          logger: app.log
        });
        app.log.info({ gatewayUrl }, "Feishu websocket bridge started");
      } catch (error) {
        app.log.error(error, "Failed to start Feishu websocket bridge");
      }
    }

    const shutdown = async () => {
      await feishuBridgeHandle?.stop().catch((error) => {
        app.log.error(error, "Failed to stop Feishu websocket bridge");
      });
      await watcherHandle?.stop().catch((error) => {
        app.log.error(error, "Failed to stop Codex global watcher");
      });
      await app.close();
    };

    process.once("SIGINT", () => {
      void shutdown().finally(() => process.exit(0));
    });
    process.once("SIGTERM", () => {
      void shutdown().finally(() => process.exit(0));
    });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void main();
