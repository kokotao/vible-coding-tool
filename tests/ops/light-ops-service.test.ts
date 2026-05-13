import { describe, expect, it } from "vitest";
import { LightOpsService } from "../../src/modules/ops/light-ops-service";
import { AuditLogRepository } from "../../src/storage/repositories/audit-log-repository";
import { FeishuSessionRouteRepository } from "../../src/storage/repositories/feishu-session-route-repository";
import { MessageRepository } from "../../src/storage/repositories/message-repository";
import { RiskConfirmationRepository } from "../../src/storage/repositories/risk-confirmation-repository";
import { TaskDispatchContextRepository } from "../../src/storage/repositories/task-dispatch-context-repository";
import { TaskRepository } from "../../src/storage/repositories/task-repository";
import { ToolSessionRepository } from "../../src/storage/repositories/tool-session-repository";
import { createSqliteDatabase, migrateDatabase } from "../../src/storage/sqlite";

describe("light ops service", () => {
  it("marks approved high-risk task as failed when dispatch cannot resume", async () => {
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const tasks = new TaskRepository(db);
    const toolSessions = new ToolSessionRepository(db);
    const risks = new RiskConfirmationRepository(db);
    const messages = new MessageRepository(db);
    const contexts = new TaskDispatchContextRepository(db);

    toolSessions.create({
      sessionId: "session-risk-fail",
      toolProvider: "codex",
      toolSessionRef: "thread-risk-fail",
      status: "waiting_confirm",
      createdBy: "ou_operator",
      createdAt: "2026-05-10T10:00:00.000Z",
      updatedAt: "2026-05-10T10:00:00.000Z"
    });
    tasks.create({
      taskId: "task-risk-fail",
      sessionId: "session-risk-fail",
      triggerMessageId: "evt-risk-fail",
      taskType: "command",
      status: "pending_confirm",
      summary: "deploy prod now",
      startedAt: "2026-05-10T10:00:00.000Z",
      finishedAt: null
    });
    risks.create({
      taskId: "task-risk-fail",
      sessionId: "session-risk-fail",
      requestedBy: "ou_operator",
      confirmationToken: "confirm-risk-fail",
      status: "pending",
      expiredAt: "2026-05-10T11:00:00.000Z",
      confirmedBy: null,
      confirmedAt: null
    });
    contexts.upsert({
      taskId: "task-risk-fail",
      sessionId: "session-risk-fail",
      threadRef: "thread-risk-fail",
      projectPath: "/tmp/project-risk-fail",
      modelSlug: null,
      modelReasoningLevel: null,
      createdAt: "2026-05-10T10:00:00.000Z",
      updatedAt: "2026-05-10T10:00:00.000Z"
    });

    const service = new LightOpsService({
      taskRepository: tasks,
      riskConfirmationRepository: risks,
      toolSessionRepository: toolSessions,
      messageRepository: messages,
      auditLogRepository: new AuditLogRepository(db),
      feishuSessionRouteRepository: new FeishuSessionRouteRepository(db),
      taskDispatchContextRepository: contexts,
      codexDispatchService: {
        dispatchTask() {
          return {
            accepted: false,
            skipped: true,
            reason: "dispatch_disabled",
            pid: null,
            threadRef: "thread-risk-fail",
            command: []
          };
        }
      } as never
    });

    const result = await service.confirmRisk("confirm-risk-fail");

    expect(result).toMatchObject({
      success: false,
      riskStatus: "approved",
      taskStatus: "failed",
      message: "Risk confirmation approved but dispatch failed"
    });

    expect(tasks.findByTaskId("task-risk-fail")?.status).toBe("failed");
    expect(toolSessions.findBySessionId("session-risk-fail")?.status).toBe("paused");
    expect(risks.findByToken("confirm-risk-fail")?.status).toBe("approved");

    const lastMessage = messages.listByTaskId("task-risk-fail").at(-1);
    expect(lastMessage?.status).toBe("failed");
    expect(lastMessage?.content).toContain("dispatch failed");
  });
});
