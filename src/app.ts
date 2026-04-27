import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mergeEnv, type AppEnv } from "./config/env";
import { AppError } from "./lib/errors";
import { createLoggerOptions } from "./lib/logger";
import { ConnectorConfigService } from "./modules/connectors/connector-config-service";
import { ConnectorService } from "./modules/connectors/connector-service";
import { CodexDispatchService } from "./modules/codex/codex-dispatch-service";
import { CodexEventService } from "./modules/codex/codex-event-service";
import { CodexQueryService } from "./modules/codex/codex-query-service";
import { DashboardService } from "./modules/dashboard/dashboard-service";
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
import { registerTaskRoutes } from "./routes/tasks";
import { AuditLogRepository } from "./storage/repositories/audit-log-repository";
import { ConnectorConfigRepository } from "./storage/repositories/connector-config-repository";
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
};

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
  const connectorConfigService = new ConnectorConfigService(connectorConfigRepository);
  const connectorService = new ConnectorService(connectorConfigService);
  const feishuNotifier = new FeishuOutboundNotifier(connectorConfigService, {
    openBaseUrl: env.feishuOpenBaseUrl
  });
  const feishuDirectoryService = new FeishuDirectoryService({
    messageRepository,
    feishuNotifier
  });
  const codexEventService = new CodexEventService({
    taskRepository,
    messageRepository,
    toolSessionRepository,
    auditLogRepository,
    idempotencyRepository,
    sessionThreadRepository,
    feishuNotifier
  });
  const codexDispatchService = new CodexDispatchService(
    {
      codexEventService,
      auditLogRepository,
      toolSessionRepository
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
    auditLogRepository
  });
  const lightOpsService = new LightOpsService({
    taskRepository,
    riskConfirmationRepository,
    toolSessionRepository,
    messageRepository,
    auditLogRepository,
    codexDispatchService,
    feishuNotifier
  });

  migrateDatabase(db);
  connectorConfigService.ensureDefaults();

  const app = Fastify({
    logger: createLoggerOptions(env.logLevel)
  });

  app.decorate("db", db);
  void app.register(fastifyStatic, {
    root: resolve(process.cwd(), "public"),
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
  registerRiskRoutes(app, lightOpsService);
  registerFeishuRoutes(
    app,
    new FeishuWebhookService({
      taskRepository,
      messageRepository,
      riskConfirmationRepository,
      toolSessionRepository,
      sessionThreadRepository,
      connectorConfigService,
      idempotencyRepository,
      codexDispatchService,
      feishuNotifier
    }),
    feishuDirectoryService,
    env.feishuVerifyToken,
    env.feishuEncryptKey
  );
  app.get("/", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(readFileSync(resolve(process.cwd(), "public", "index.html"), "utf8"));
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      void reply.status(error.statusCode).send({
        code: error.code,
        message: error.message
      });
      return;
    }

    app.log.error(error);
    void reply.status(500).send({
      code: "INTERNAL_SERVER_ERROR",
      message: "Unexpected server error"
    });
  });

  app.addHook("onClose", async () => {
    db.close();
  });

  return app;
}
