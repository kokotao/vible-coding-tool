import { describe, expect, it, vi } from "vitest";
import { CommandIntakeService } from "../../src/modules/commands/command-intake-service";
import { ConnectorConfigService } from "../../src/modules/connectors/connector-config-service";
import { ConnectorConfigRepository } from "../../src/storage/repositories/connector-config-repository";
import { MessageRepository } from "../../src/storage/repositories/message-repository";
import { RiskConfirmationRepository } from "../../src/storage/repositories/risk-confirmation-repository";
import { TaskDispatchContextRepository } from "../../src/storage/repositories/task-dispatch-context-repository";
import { TaskRepository } from "../../src/storage/repositories/task-repository";
import { ToolSessionRepository } from "../../src/storage/repositories/tool-session-repository";
import { createSqliteDatabase, migrateDatabase } from "../../src/storage/sqlite";

describe("command intake service", () => {
  it("stores pending high-risk task with risk confirmation and dispatch context", () => {
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);
    const connectorConfigService = new ConnectorConfigService(new ConnectorConfigRepository(db));
    connectorConfigService.updateConfig("feishu", {
      ...connectorConfigService.getConfig("feishu"),
      platform: "feishu",
      riskKeywords: ["危险词"],
      confirmTimeoutSeconds: 300
    });

    const dispatchCalls: Array<Record<string, unknown>> = [];
    const service = new CommandIntakeService({
      db,
      connectorConfigService,
      taskRepository: new TaskRepository(db),
      messageRepository: new MessageRepository(db),
      riskConfirmationRepository: new RiskConfirmationRepository(db),
      toolSessionRepository: new ToolSessionRepository(db),
      taskDispatchContextRepository: new TaskDispatchContextRepository(db),
      codexDispatchService: {
        dispatchTask(input: Record<string, unknown>) {
          dispatchCalls.push(input);
          return {
            accepted: true,
            skipped: false,
            reason: null,
            pid: 100,
            threadRef: input.threadRef as string | null,
            command: ["codex", "exec"]
          };
        }
      } as never
    });

    const result = service.acceptCommand({
      sessionId: "session-risk-1",
      actorId: "web_console",
      sourcePlatform: "web_console",
      prompt: "删除 危险词 文件",
      taskType: "web_local_session_chat",
      threadRef: "019dca59-78b8-7d10-88fd-b6f9b8a7c409",
      projectPath: "/tmp/project-a"
    });

    expect(result.pendingConfirmation).toBe(true);
    expect(result.dispatch.accepted).toBe(false);
    expect(result.dispatch.reason).toBe("pending_confirmation");
    expect(dispatchCalls).toHaveLength(0);

    const task = new TaskRepository(db).findByTaskId(result.taskId);
    expect(task?.status).toBe("pending_confirm");

    const risks = new RiskConfirmationRepository(db).listByTaskId(result.taskId);
    expect(risks).toHaveLength(1);
    expect(risks[0]?.status).toBe("pending");

    const context = new TaskDispatchContextRepository(db).findByTaskId(result.taskId);
    expect(context).toMatchObject({
      taskId: result.taskId,
      sessionId: "session-risk-1",
      threadRef: "019dca59-78b8-7d10-88fd-b6f9b8a7c409",
      projectPath: "/tmp/project-a"
    });
  });

  it("rejects a new command when session already has an active task and busy guard is enabled", () => {
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);
    const service = new CommandIntakeService({
      db,
      connectorConfigService: new ConnectorConfigService(new ConnectorConfigRepository(db)),
      taskRepository: new TaskRepository(db),
      messageRepository: new MessageRepository(db),
      riskConfirmationRepository: new RiskConfirmationRepository(db),
      toolSessionRepository: new ToolSessionRepository(db),
      taskDispatchContextRepository: new TaskDispatchContextRepository(db),
      codexDispatchService: {
        dispatchTask() {
          return {
            accepted: true,
            skipped: false,
            reason: null,
            pid: 100,
            threadRef: null,
            command: ["codex", "exec"]
          };
        }
      } as never
    });

    const toolSessions = new ToolSessionRepository(db);
    const tasks = new TaskRepository(db);
    toolSessions.create({
      sessionId: "session-busy-1",
      toolProvider: "codex",
      toolSessionRef: "019dca59-78b8-7d10-88fd-b6f9b8a7c409",
      status: "running",
      createdBy: "alice",
      createdAt: "2026-05-10T00:00:00.000Z",
      updatedAt: "2026-05-10T00:00:00.000Z"
    });
    tasks.create({
      taskId: "task-busy-1",
      sessionId: "session-busy-1",
      triggerMessageId: "evt-busy-1",
      taskType: "command",
      status: "running",
      summary: "still running",
      startedAt: "2026-05-10T00:00:00.000Z",
      finishedAt: null
    });

    expect(() =>
      service.acceptCommand({
        sessionId: "session-busy-1",
        actorId: "web_console",
        sourcePlatform: "web_console",
        prompt: "second command",
        taskType: "web_local_session_chat",
        busyGuard: true
      })
    ).toThrow(/busy/i);
  });

  it("uses explicit connector risk policy instead of merging all connector keywords", () => {
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);
    const connectorConfigService = new ConnectorConfigService(new ConnectorConfigRepository(db));
    connectorConfigService.updateConfig("feishu", {
      ...connectorConfigService.getConfig("feishu"),
      platform: "feishu",
      riskKeywords: ["feishu-only-risk"],
      confirmTimeoutSeconds: 300
    });
    connectorConfigService.updateConfig("qq", {
      ...connectorConfigService.getConfig("qq"),
      platform: "qq",
      riskKeywords: ["qq-only-risk"],
      confirmTimeoutSeconds: 180
    });

    const service = new CommandIntakeService({
      db,
      connectorConfigService,
      taskRepository: new TaskRepository(db),
      messageRepository: new MessageRepository(db),
      riskConfirmationRepository: new RiskConfirmationRepository(db),
      toolSessionRepository: new ToolSessionRepository(db),
      taskDispatchContextRepository: new TaskDispatchContextRepository(db),
      codexDispatchService: {
        dispatchTask() {
          return {
            accepted: true,
            skipped: false,
            reason: null,
            pid: 100,
            threadRef: null,
            command: ["codex", "exec"]
          };
        }
      } as never
    });

    const result = service.acceptCommand({
      sessionId: "qq-session-1",
      actorId: "qq_user",
      sourcePlatform: "qq",
      prompt: "处理 feishu-only-risk 标记文件",
      taskType: "command",
      riskKeywords: ["qq-only-risk"],
      confirmTimeoutSeconds: 180
    });

    expect(result.riskLevel).toBe("low");
    expect(result.pendingConfirmation).toBe(false);
  });

  it("rejects reentrant admission for the same session before task creation completes", () => {
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);
    const connectorConfigService = new ConnectorConfigService(new ConnectorConfigRepository(db));
    const taskRepository = new TaskRepository(db);
    const service = new CommandIntakeService({
      db,
      connectorConfigService,
      taskRepository,
      messageRepository: new MessageRepository(db),
      riskConfirmationRepository: new RiskConfirmationRepository(db),
      toolSessionRepository: new ToolSessionRepository(db),
      taskDispatchContextRepository: new TaskDispatchContextRepository(db),
      codexDispatchService: {
        dispatchTask() {
          return {
            accepted: true,
            skipped: false,
            reason: null,
            pid: 100,
            threadRef: null,
            command: ["codex", "exec"]
          };
        }
      } as never
    });

    const originalCount = taskRepository.countActiveBySessionId.bind(taskRepository);
    let nestedError: unknown = null;
    let reentered = false;
    vi.spyOn(taskRepository, "countActiveBySessionId").mockImplementation((sessionId: string) => {
      if (!reentered) {
        reentered = true;
        try {
          service.acceptCommand({
            sessionId,
            actorId: "nested-user",
            sourcePlatform: "web_console",
            prompt: "nested command",
            taskType: "web_local_session_chat",
            busyGuard: true
          });
        } catch (error) {
          nestedError = error;
        }
      }
      return originalCount(sessionId);
    });

    service.acceptCommand({
      sessionId: "session-lock-1",
      actorId: "root-user",
      sourcePlatform: "web_console",
      prompt: "root command",
      taskType: "web_local_session_chat",
      busyGuard: true
    });

    expect(nestedError).toMatchObject({
      code: "SESSION_BUSY"
    });
  });
});
