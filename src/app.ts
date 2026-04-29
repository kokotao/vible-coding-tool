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
import { CodexDispatchService } from "./modules/codex/codex-dispatch-service";
import { CodexEventService } from "./modules/codex/codex-event-service";
import { CodexCliRuntimeService } from "./modules/codex/codex-cli-runtime-service";
import { CodexLocalSessionService } from "./modules/codex/codex-local-session-service";
import { CodexModelCatalogService } from "./modules/codex/codex-model-catalog-service";
import { CodexQueryService } from "./modules/codex/codex-query-service";
import { DashboardService } from "./modules/dashboard/dashboard-service";
import { FeishuCommandPanelService } from "./modules/feishu/feishu-command-panel-service";
import { FeishuIdentityService } from "./modules/feishu/feishu-identity-service";
import { FeishuDirectoryService } from "./modules/feishu/feishu-directory-service";
import { FeishuWebhookService } from "./modules/feishu/feishu-webhook-service";
import { FeishuOutboundNotifier } from "./modules/notifications/feishu-outbound-notifier";
import { LightOpsService } from "./modules/ops/light-ops-service";
import { SessionQueryService } from "./modules/sessions/session-query-service";
import { TaskQueryService } from "./modules/tasks/task-query-service";
import { registerCodexRoutes } from "./routes/codex";
import { registerConnectorRoutes } from "./routes/connectors";
import { registerDashboardRoutes } from "./routes/dashboard";
import { registerFeishuRoutes } from "./routes/feishu";
import { registerHealthRoute } from "./routes/health";
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
  const lightOpsService = new LightOpsService({
    taskRepository,
    riskConfirmationRepository,
    toolSessionRepository,
    messageRepository,
    auditLogRepository,
    feishuSessionRouteRepository,
    codexDispatchService,
    feishuNotifier
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
    lightOpsService
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
    idempotencyRepository,
    {
      ingressToken: env.codexIngressToken,
      signingSecret: env.codexIngressSigningSecret,
      maxSkewSeconds: env.codexIngressMaxSkewSeconds
    }
  );
  registerConnectorRoutes(app, connectorConfigService);
  registerSystemRoutes(app, codexCliRuntimeService);
  registerRiskRoutes(app, lightOpsService);
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
      codexDispatchService,
      feishuNotifier,
      feishuIdentityService,
      feishuCommandPanelService,
      codexLocalSessionService: codexLocalSessionService ?? undefined,
      lightOpsService,
      terminalEventStream: options.terminalEventStream
    }),
    feishuDirectoryService,
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
