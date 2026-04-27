import { AuditLogRepository } from "../../src/storage/repositories/audit-log-repository";
import { MessageRepository } from "../../src/storage/repositories/message-repository";
import { RiskConfirmationRepository } from "../../src/storage/repositories/risk-confirmation-repository";
import { TaskRepository } from "../../src/storage/repositories/task-repository";
import { ToolSessionRepository } from "../../src/storage/repositories/tool-session-repository";
import type { SqliteDatabase } from "../../src/storage/sqlite";

export function seedAppData(db: SqliteDatabase) {
  const toolSessions = new ToolSessionRepository(db);
  const tasks = new TaskRepository(db);
  const messages = new MessageRepository(db);
  const risks = new RiskConfirmationRepository(db);
  const audits = new AuditLogRepository(db);

  const now = new Date("2026-04-26T00:20:00.000Z");
  const earlier = new Date("2026-04-26T00:10:00.000Z");
  const middle = new Date("2026-04-26T00:15:00.000Z");

  toolSessions.create({
    sessionId: "feishu-codex-0001",
    toolProvider: "codex",
    toolSessionRef: "codex-session-1",
    status: "running",
    createdBy: "alice",
    createdAt: earlier.toISOString(),
    updatedAt: now.toISOString()
  });

  toolSessions.create({
    sessionId: "feishu-codex-0002",
    toolProvider: "codex",
    toolSessionRef: "codex-session-2",
    status: "waiting_confirm",
    createdBy: "bob",
    createdAt: earlier.toISOString(),
    updatedAt: middle.toISOString()
  });

  tasks.create({
    taskId: "task-1",
    sessionId: "feishu-codex-0001",
    triggerMessageId: "evt-1",
    taskType: "command",
    status: "running",
    summary: "Fix login issue",
    startedAt: earlier.toISOString(),
    finishedAt: null
  });

  tasks.create({
    taskId: "task-2",
    sessionId: "feishu-codex-0002",
    triggerMessageId: "evt-3",
    taskType: "command",
    status: "pending_confirm",
    summary: "Deploy to prod",
    startedAt: middle.toISOString(),
    finishedAt: null
  });

  tasks.create({
    taskId: "task-3",
    sessionId: "feishu-codex-0002",
    triggerMessageId: "evt-5",
    taskType: "command",
    status: "failed",
    summary: "Rebuild failed",
    startedAt: now.toISOString(),
    finishedAt: now.toISOString()
  });

  messages.create({
    eventId: "evt-1",
    sessionId: "feishu-codex-0001",
    direction: "bot_to_tool",
    sourcePlatform: "feishu",
    platformMessageId: "im-1",
    senderId: "alice",
    content: "修复登录接口 500 问题",
    messageType: "command",
    riskLevel: "low",
    status: "received",
    taskId: "task-1",
    createdAt: earlier.toISOString()
  });

  messages.create({
    eventId: "evt-2",
    sessionId: "feishu-codex-0001",
    direction: "tool_to_bot",
    sourcePlatform: "codex",
    platformMessageId: null,
    senderId: "codex",
    content: "已经定位到认证中间件异常，正在修复",
    messageType: "tool_event",
    riskLevel: "low",
    status: "running",
    taskId: "task-1",
    createdAt: now.toISOString()
  });

  messages.create({
    eventId: "evt-3",
    sessionId: "feishu-codex-0002",
    direction: "bot_to_tool",
    sourcePlatform: "feishu",
    platformMessageId: "im-2",
    senderId: "bob",
    content: "把新版本直接部署到生产",
    messageType: "command",
    riskLevel: "high",
    status: "pending_confirm",
    taskId: "task-2",
    createdAt: middle.toISOString()
  });

  messages.create({
    eventId: "evt-4",
    sessionId: "feishu-codex-0002",
    direction: "tool_to_bot",
    sourcePlatform: "codex",
    platformMessageId: null,
    senderId: "codex",
    content: "该操作命中生产环境发布策略，需要确认",
    messageType: "tool_event",
    riskLevel: "high",
    status: "pending_confirm",
    taskId: "task-2",
    createdAt: now.toISOString()
  });

  messages.create({
    eventId: "evt-5",
    sessionId: "feishu-codex-0002",
    direction: "bot_to_tool",
    sourcePlatform: "feishu",
    platformMessageId: "im-3",
    senderId: "bob",
    content: "重新构建并跑一遍回归",
    messageType: "command",
    riskLevel: "low",
    status: "failed",
    taskId: "task-3",
    createdAt: now.toISOString()
  });

  risks.create({
    taskId: "task-2",
    sessionId: "feishu-codex-0002",
    requestedBy: "bob",
    confirmationToken: "confirm-task-2",
    status: "pending",
    expiredAt: new Date("2026-04-26T00:30:00.000Z").toISOString(),
    confirmedBy: null,
    confirmedAt: null
  });

  audits.create({
    eventId: "audit-evt-1",
    taskId: "task-1",
    sessionId: "feishu-codex-0001",
    action: "dispatch_task",
    actorId: "alice",
    result: "success",
    detail: "Task accepted by gateway",
    createdAt: earlier.toISOString()
  });

  audits.create({
    eventId: "audit-evt-2",
    taskId: "task-1",
    sessionId: "feishu-codex-0001",
    action: "push_update",
    actorId: "codex",
    result: "success",
    detail: "Sent running status back to Feishu",
    createdAt: now.toISOString()
  });
}
