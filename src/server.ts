import { buildApp } from "./app";
import { loadEnv } from "./config/env";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { loadEnvFile } from "node:process";
import { resolveLogFilePath } from "./lib/logger";
import { createTerminalEventStream } from "./lib/terminal-event-stream";
import {
  resolveCodexGlobalWatcherDefaults,
  startCodexGlobalWatcher,
  type CodexGlobalWatcherHandle
} from "./modules/codex/codex-global-watcher";
import { CodexCliRuntimeService, type CodexCliRuntimeStatus } from "./modules/codex/codex-cli-runtime-service";
import {
  resolveFeishuWsBridgeDefaults,
  startFeishuWsBridge,
  type FeishuWsBridgeHandle
} from "./modules/feishu/feishu-ws-bridge";
import { resolveQqWsBridgeDefaults, startQqWsBridge, type QqWsBridgeHandle } from "./modules/qq/qq-ws-bridge";

function loadLocalEnvFiles() {
  const localEnvFiles = [".env.local", ".env"];
  for (const file of localEnvFiles) {
    if (existsSync(file)) {
      loadEnvFile(file);
    }
  }
}

async function main() {
  loadLocalEnvFiles();
  const env = loadEnv();
  const terminalEventStream = createTerminalEventStream();
  installGlobalErrorHooks(terminalEventStream);
  const codexCliRuntimeService = new CodexCliRuntimeService({
    codexBin: env.codexCliBin,
    projectRoot: process.cwd()
  });
  const app = buildApp({
    env,
    codexCliRuntimeService,
    terminalEventStream
  });
  let watcherHandle: CodexGlobalWatcherHandle | null = null;
  let feishuBridgeHandle: FeishuWsBridgeHandle | null = null;
  let qqBridgeHandle: QqWsBridgeHandle | null = null;
  const watcherDefaults = resolveCodexGlobalWatcherDefaults();
  const feishuBridgeDefaults = resolveFeishuWsBridgeDefaults();
  const qqBridgeDefaults = resolveQqWsBridgeDefaults();

  try {
    const startupStatus = codexCliRuntimeService.getStatus({
      refresh: true
    });
    app.log.info(
      {
        installed: startupStatus.installed,
        version: startupStatus.version,
        sessionScan: startupStatus.sessionScan,
        projectAuthorization: startupStatus.projectAuthorization
      },
      "Codex startup initialization completed"
    );

    await app.listen({
      host: env.host,
      port: env.port
    });
    const baseHost = resolveBrowserHost(env.host);
    const baseUrl = `http://${baseHost}:${env.port}`;
    const systemConfigUrl = `${baseUrl}/?drawer=system`;
    printStartupBanner({
      baseUrl,
      logDir: env.logDir,
      logFile: resolveLogFilePath(env.logDir),
      status: startupStatus,
      systemConfigUrl
    });
    if (env.autoOpenBrowser) {
      openUrlInDefaultBrowser(systemConfigUrl);
      app.log.info({ url: systemConfigUrl }, "Opened browser for system configuration");
    }

    codexCliRuntimeService.emitStartupGuidance({
      logger: app.log,
      systemConfigUrl
    });
    void codexCliRuntimeService
      .probeAvailabilityAtStartup()
      .then((status) => {
        app.log.info(
          {
            usable: status.apiConfig.usable,
            probeCheckedAt: status.apiConfig.probeCheckedAt,
            probeMessage: status.apiConfig.probeMessage
          },
          "Codex availability probe finished after startup"
        );
      })
      .catch((error) => {
        app.log.warn(
          {
            error: error instanceof Error ? error.message : String(error)
          },
          "Codex availability probe failed after startup"
        );
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
          signingSecret: watcherDefaults.signingSecret,
          logger: app.log
        });
        app.log.info(
          { gatewayUrl, sessionId: watcherDefaults.sessionId || null },
          "Codex global watcher started"
        );
      } catch (error) {
        app.log.error(error, "Failed to start Codex global watcher");
        terminalEventStream.error("启动 Codex Watcher 失败", error);
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
        terminalEventStream.error("启动 Feishu WS Bridge 失败", error);
      }
    }

    if (env.qqWsAutoStart && qqBridgeDefaults.autoStart) {
      const gatewayUrl = `http://127.0.0.1:${env.port}`;
      try {
        qqBridgeHandle = await startQqWsBridge({
          gatewayUrl,
          logger: app.log
        });
        if (qqBridgeHandle.active) {
          app.log.info({ gatewayUrl }, "QQ websocket bridge started");
        } else {
          app.log.info({ gatewayUrl }, "QQ websocket bridge skipped");
        }
      } catch (error) {
        app.log.error(error, "Failed to start QQ websocket bridge");
        terminalEventStream.error("Failed to start QQ websocket bridge", error);
      }
    }

    const shutdown = async () => {
      await qqBridgeHandle?.stop().catch((error) => {
        app.log.error(error, "Failed to stop QQ websocket bridge");
        terminalEventStream.error("Failed to stop QQ websocket bridge", error);
      });
      await feishuBridgeHandle?.stop().catch((error) => {
        app.log.error(error, "Failed to stop Feishu websocket bridge");
        terminalEventStream.error("停止 Feishu WS Bridge 失败", error);
      });
      await watcherHandle?.stop().catch((error) => {
        app.log.error(error, "Failed to stop Codex global watcher");
        terminalEventStream.error("停止 Codex Watcher 失败", error);
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
    terminalEventStream.error("服务启动失败", error);
    process.exit(1);
  }
}

void main();

function resolveBrowserHost(host: string) {
  const normalized = host.trim();
  if (!normalized || normalized === "0.0.0.0" || normalized === "::") {
    return "127.0.0.1";
  }
  return normalized;
}

function openUrlInDefaultBrowser(url: string) {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      }).unref();
      return;
    }

    if (process.platform === "darwin") {
      spawn("open", [url], {
        detached: true,
        stdio: "ignore"
      }).unref();
      return;
    }

    spawn("xdg-open", [url], {
      detached: true,
      stdio: "ignore"
    }).unref();
  } catch {
    // ignore browser open failures
  }
}

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m"
} as const;

function withColor(text: string, color: string) {
  if (!process.stdout.isTTY) {
    return text;
  }
  return `${color}${text}${ANSI.reset}`;
}

function printStartupBanner(input: {
  baseUrl: string;
  logDir: string;
  logFile: string;
  status: CodexCliRuntimeStatus;
  systemConfigUrl: string;
}) {
  const statusTone = input.status.installed ? ANSI.green : ANSI.yellow;
  const statusLabel = input.status.installed
    ? `已安装${input.status.version ? ` (${input.status.version})` : ""}`
    : "未安装";
  const line = withColor("=".repeat(76), ANSI.cyan);
  console.log("");
  console.log(line);
  console.log(withColor(`${ANSI.bold}灵犀桥（Lingxi Bridge）网关启动完成${ANSI.reset}`, ANSI.magenta));
  console.log(withColor(`服务地址      ${input.baseUrl}`, ANSI.green));
  console.log(withColor(`系统配置页    ${input.systemConfigUrl}`, ANSI.cyan));
  console.log(withColor(`CLI 状态      ${statusLabel}`, statusTone));
  console.log(withColor(`日志目录      ${input.logDir}`, ANSI.gray));
  console.log(withColor(`当日日志      ${input.logFile}`, ANSI.gray));
  if (input.status.detectionMessage && !input.status.installed) {
    console.log(withColor(`检测提示      ${input.status.detectionMessage}`, ANSI.yellow));
  }
  if (input.status.setupWizard?.required) {
    console.log(withColor("安装向导      检测到当前设备尚未完成首次配置，请按以下步骤执行：", ANSI.yellow));
    input.status.setupWizard.steps.forEach((step, index) => {
      const flag = step.completed ? "已完成" : "待完成";
      console.log(withColor(`             ${index + 1}. [${flag}] ${step.title} - ${step.description}`, ANSI.yellow));
    });
    console.log(withColor("快捷命令      ", ANSI.cyan) + input.status.setupWizard.quickCommands.join("  |  "));
  }
  console.log(withColor(`终端说明      当前窗口仅用于日志展示，不接收业务指令；请在飞书中发指令。配置请到 ${input.systemConfigUrl}`, ANSI.yellow));
  console.log(withColor("飞书快捷流程  1) 绑定姓名：张三", ANSI.cyan));
  console.log(withColor("             2) 查看项目  ->  选择项目：vible-coding-Tool", ANSI.cyan));
  console.log(withColor("             3) 查看session -> 选择session：<threadId>", ANSI.cyan));
  console.log(withColor("             4) 开始任务：<任务内容>  或直接发送任务内容", ANSI.cyan));
  console.log(withColor("线程直达模板  线程 ID：<uuid>，任务内容：<任务内容>", ANSI.cyan));
  console.log(withColor("常用查询      指令帮助 / 查看模型列表 / 查看网关状态", ANSI.cyan));
  console.log(withColor("退出服务      Ctrl+C", ANSI.cyan));
  console.log(line);
  console.log("");
}

function installGlobalErrorHooks(eventStream: ReturnType<typeof createTerminalEventStream>) {
  process.on("uncaughtException", (error) => {
    eventStream.error("未捕获异常", error);
  });
  process.on("unhandledRejection", (reason) => {
    eventStream.error("未处理 Promise 拒绝", reason);
  });
}
