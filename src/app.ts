import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mergeEnv, type AppEnv } from "./config/env";
import { AppError } from "./lib/errors";
import { createLoggerOptions } from "./lib/logger";
import type { TerminalEventStream } from "./lib/terminal-event-stream";
import { ConnectorConfigService } from "./modules/connectors/connector-config-service";
import { ConnectorService } from "./modules/connectors/connector-service";
import { CommandIntakeService } from "./modules/commands/command-intake-service";
import { CodexDispatchService } from "./modules/codex/codex-dispatch-service";
import { CodexEventService } from "./modules/codex/codex-event-service";
import { CodexCliRuntimeService } from "./modules/codex/codex-cli-runtime-service";
import { CodexLocalSessionService } from "./modules/codex/codex-local-session-service";
import { CodexModelCatalogService } from "./modules/codex/codex-model-catalog-service";
import { CodexQueryService } from "./modules/codex/codex-query-service";
import { CodexWebChatService } from "./modules/codex/codex-web-chat-service";
import { DashboardService } from "./modules/dashboard/dashboard-service";
import { FeishuCommandPanelService } from "./modules/feishu/feishu-command-panel-service";
import { FeishuIdentityService } from "./modules/feishu/feishu-identity-service";
import { FeishuFileService } from "./modules/feishu/feishu-file-service";
import { FeishuImageService } from "./modules/feishu/feishu-image-service";
import { FeishuDirectoryService } from "./modules/feishu/feishu-directory-service";
import { FeishuWebhookService } from "./modules/feishu/feishu-webhook-service";
import { FeishuOutboundNotifier } from "./modules/notifications/feishu-outbound-notifier";
import { QqOutboundNotifier } from "./modules/notifications/qq-outbound-notifier";
import { LightOpsService } from "./modules/ops/light-ops-service";
import { QqImageService } from "./modules/qq/qq-image-service";
import { QqWebhookService } from "./modules/qq/qq-webhook-service";
import { SessionQueryService } from "./modules/sessions/session-query-service";
import { TaskQueryService } from "./modules/tasks/task-query-service";
import { registerCodexRoutes } from "./routes/codex";
import { registerConnectorRoutes } from "./routes/connectors";
import { registerDashboardRoutes } from "./routes/dashboard";
import { registerFeishuRoutes } from "./routes/feishu";
import { registerHealthRoute } from "./routes/health";
import { registerQqRoutes } from "./routes/qq";
import { registerRiskRoutes } from "./routes/risks";
import { registerSessionRoutes } from "./routes/sessions";
import { registerSystemRoutes } from "./routes/system";
import { registerTaskRoutes } from "./routes/tasks";
import { AuditLogRepository } from "./storage/repositories/audit-log-repository";
import { ConnectorConfigRepository } from "./storage/repositories/connector-config-repository";
import { FeishuIdentityRepository } from "./storage/repositories/feishu-identity-repository";
import { FeishuPanelContextRepository } from "./storage/repositories/feishu-panel-context-repository";
import { FeishuSessionRouteRepository } from "./storage/repositories/feishu-session-route-repository";
import { IdempotencyRepository } from "./storage/repositories/idempotency-repository";
import { MessageRepository } from "./storage/repositories/message-repository";
import { RiskConfirmationRepository } from "./storage/repositories/risk-confirmation-repository";
import { SessionThreadRepository } from "./storage/repositories/session-thread-repository";
import { TaskDispatchContextRepository } from "./storage/repositories/task-dispatch-context-repository";
import { TaskRepository } from "./storage/repositories/task-repository";
import { ToolSessionRepository } from "./storage/repositories/tool-session-repository";
import { createSqliteDatabase, migrateDatabase, type SqliteDatabase } from "./storage/sqlite";

export type BuildAppOptions = {
  env?: Partial<AppEnv>;
  db?: SqliteDatabase;
  fetchImpl?: typeof fetch;
  codexCliRuntimeService?: CodexCliRuntimeService;
  terminalEventStream?: TerminalEventStream;
};

function resolvePublicRoot(): string {
  const candidates = [
    resolve(process.cwd(), "public"),
    resolve(__dirname, "..", "public"),
    resolve(__dirname, "..", "..", "public")
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const env = mergeEnv(options.env);
  const db = options.db ?? createSqliteDatabase(env.databasePath);
  const taskRepository = new TaskRepository(db);
  const messageRepository = new MessageRepository(db);
  const riskConfirmationRepository = new RiskConfirmationRepository(db);
  const toolSessionRepository = new ToolSessionRepository(db);
  const sessionThreadRepository = new SessionThreadRepository(db);
  const taskDispatchContextRepository = new TaskDispatchContextRepository(db);
  const auditLogRepository = new AuditLogRepository(db);
  const idempotencyRepository = new IdempotencyRepository(db);
  const connectorConfigRepository = new ConnectorConfigRepository(db);
  const feishuIdentityRepository = new FeishuIdentityRepository(db);
  const feishuPanelContextRepository = new FeishuPanelContextRepository(db);
  const feishuSessionRouteRepository = new FeishuSessionRouteRepository(db);
  const connectorConfigService = new ConnectorConfigService(connectorConfigRepository);
  const connectorService = new ConnectorService(connectorConfigService);
  const feishuNotifier = new FeishuOutboundNotifier(connectorConfigService, {
    openBaseUrl: env.feishuOpenBaseUrl,
    fetchImpl: options.fetchImpl,
    idempotencyRepository,
    feishuIdentityRepository
  });
  const qqNotifier = new QqOutboundNotifier(connectorConfigService, {
    fetchImpl: options.fetchImpl
  });
  const qqImageService = new QqImageService({
    fetchImpl: options.fetchImpl
  });
  const codexLocalSessionService = env.codexLocalSessionsScanEnabled
    ? new CodexLocalSessionService({
        rootPath: env.codexLocalSessionsRoot,
        scanIntervalMs: env.codexLocalSessionsScanIntervalMs
      })
    : null;
  codexLocalSessionService?.start();
  const feishuIdentityService = new FeishuIdentityService({
    connectorConfigService,
    identityRepository: feishuIdentityRepository,
    fetchImpl: options.fetchImpl,
    openBaseUrl: env.feishuOpenBaseUrl
  });
  const feishuImageService = new FeishuImageService({
    connectorConfigService,
    fetchImpl: options.fetchImpl,
    openBaseUrl: env.feishuOpenBaseUrl
  });
  const feishuFileService = new FeishuFileService({
    connectorConfigService,
    fetchImpl: options.fetchImpl,
    openBaseUrl: env.feishuOpenBaseUrl
  });
  const codexModelCatalogService = new CodexModelCatalogService({
    codexBin: env.codexCliBin
  });
  const codexCliRuntimeService =
    options.codexCliRuntimeService ||
    new CodexCliRuntimeService({
      codexBin: env.codexCliBin,
      projectRoot: process.cwd()
    });
  const feishuCommandPanelService = new FeishuCommandPanelService({
    contextRepository: feishuPanelContextRepository,
    codexLocalSessionService: codexLocalSessionService ?? undefined,
    codexModelCatalogService,
    codexAutoDispatchEnabled: env.codexAutoDispatchEnabled,
    codexCliBin: env.codexCliBin
  });
  const feishuDirectoryService = new FeishuDirectoryService({
    messageRepository,
    feishuNotifier,
    feishuIdentityService
  });
  const codexEventService = new CodexEventService({
    taskRepository,
    messageRepository,
    toolSessionRepository,
    auditLogRepository,
    idempotencyRepository,
    sessionThreadRepository,
    feishuSessionRouteRepository,
    feishuNotifier,
    qqNotifier,
    terminalEventStream: options.terminalEventStream
  });
  const codexDispatchService = new CodexDispatchService(
    {
      codexEventService,
      auditLogRepository,
      toolSessionRepository,
      codexCliRuntimeService
    },
    {
      enabled: env.codexAutoDispatchEnabled,
      codexBin: env.codexCliBin,
      skipGitRepoCheck: env.codexCliSkipGitRepoCheck
    }
  );
  const codexQueryService = new CodexQueryService({
    toolSessionRepository,
    taskRepository,
    messageRepository,
    auditLogRepository,
    codexLocalSessionService: codexLocalSessionService ?? undefined
  });
  const commandIntakeService = new CommandIntakeService({
    db,
    connectorConfigService,
    taskRepository,
    messageRepository,
    riskConfirmationRepository,
    toolSessionRepository,
    taskDispatchContextRepository,
    codexDispatchService
  });
  const lightOpsService = new LightOpsService({
    taskRepository,
    riskConfirmationRepository,
    toolSessionRepository,
    messageRepository,
    auditLogRepository,
    feishuSessionRouteRepository,
    taskDispatchContextRepository,
    codexDispatchService,
    feishuNotifier,
    qqNotifier
  });

  codexCliRuntimeService.initialize({
    codexLocalSessionService
  });

  migrateDatabase(db);
  connectorConfigService.ensureDefaults();

  const app = Fastify({
    logger: createLoggerOptions(env.logLevel, env.logDir, env.logRetentionDays),
    disableRequestLogging: true
  });
  const publicRoot = resolvePublicRoot();

  app.decorate("db", db);
  void app.register(fastifyStatic, {
    root: publicRoot,
    prefix: "/"
  });

  registerHealthRoute(app);
  registerDashboardRoutes(
    app,
    new DashboardService({
      taskRepository,
      messageRepository,
      riskConfirmationRepository,
      toolSessionRepository,
      connectorService
    })
  );
  registerTaskRoutes(
    app,
    new TaskQueryService({
      taskRepository,
      messageRepository,
      riskConfirmationRepository,
      auditLogRepository,
      toolSessionRepository
    }),
    lightOpsService,
    {
      adminToken: env.webAdminToken
    }
  );
  registerSessionRoutes(
    app,
    new SessionQueryService({
      toolSessionRepository,
      taskRepository,
      messageRepository,
      auditLogRepository
    })
  );
  registerCodexRoutes(
    app,
    codexEventService,
    codexQueryService,
    new CodexWebChatService({
      taskRepository,
      messageRepository,
      toolSessionRepository,
      commandIntakeService,
      codexLocalSessionService: codexLocalSessionService ?? undefined
    }),
    idempotencyRepository,
    {
      ingressToken: env.codexIngressToken,
      signingSecret: env.codexIngressSigningSecret,
      maxSkewSeconds: env.codexIngressMaxSkewSeconds
    },
    {
      adminToken: env.webAdminToken
    }
  );
  registerConnectorRoutes(app, connectorConfigService, {
    adminToken: env.webAdminToken
  });
  registerQqRoutes(
    app,
    new QqWebhookService({
      taskRepository,
      messageRepository,
      riskConfirmationRepository,
      toolSessionRepository,
      sessionThreadRepository,
      auditLogRepository,
      connectorConfigService,
      idempotencyRepository,
      feishuSessionRouteRepository,
      commandIntakeService,
      codexDispatchService,
      codexLocalSessionService: codexLocalSessionService ?? undefined,
      qqNotifier
    }),
    connectorConfigService,
    qqImageService
  );
  registerSystemRoutes(app, codexCliRuntimeService, {
    adminToken: env.webAdminToken
  });
  registerRiskRoutes(app, lightOpsService, {
    adminToken: env.webAdminToken
  });
  registerFeishuRoutes(
    app,
    new FeishuWebhookService({
      taskRepository,
      messageRepository,
      riskConfirmationRepository,
      toolSessionRepository,
      sessionThreadRepository,
      auditLogRepository,
      connectorConfigService,
      idempotencyRepository,
      feishuSessionRouteRepository,
      commandIntakeService,
      codexDispatchService,
      feishuNotifier,
      feishuIdentityService,
      feishuCommandPanelService,
      codexLocalSessionService: codexLocalSessionService ?? undefined,
      lightOpsService,
      terminalEventStream: options.terminalEventStream
    }),
    feishuDirectoryService,
    feishuFileService,
    feishuImageService,
    env.feishuVerifyToken,
    env.feishuEncryptKey
  );
  app.get("/", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(readFileSync(resolve(publicRoot, "index.html"), "utf8"));
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        options.terminalEventStream?.error(`HTTP ${error.statusCode}`, error);
      }
      void reply.status(error.statusCode).send({
        code: error.code,
        message: error.message
      });
      return;
    }

    app.log.error(error);
    options.terminalEventStream?.error("HTTP 500", error);
    void reply.status(500).send({
      code: "INTERNAL_SERVER_ERROR",
      message: "Unexpected server error"
    });
  });

  app.addHook("onClose", async () => {
    codexLocalSessionService?.stop();
    db.close();
  });

  return app;
}
