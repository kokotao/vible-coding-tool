import { AppError } from "../../lib/errors";
import { deriveTaskTitle } from "../common/display";
import { AuditLogRepository } from "../../storage/repositories/audit-log-repository";
import { MessageRepository } from "../../storage/repositories/message-repository";
import { RiskConfirmationRepository } from "../../storage/repositories/risk-confirmation-repository";
import { TaskRepository } from "../../storage/repositories/task-repository";
import { ToolSessionRepository } from "../../storage/repositories/tool-session-repository";

export type TaskQueryServiceDeps = {
  taskRepository: TaskRepository;
  messageRepository: MessageRepository;
  riskConfirmationRepository: RiskConfirmationRepository;
  auditLogRepository: AuditLogRepository;
  toolSessionRepository: ToolSessionRepository;
};

export class TaskQueryService {
  constructor(private readonly deps: TaskQueryServiceDeps) {}

  getTaskDetail(taskId: string) {
    const task = this.deps.taskRepository.findByTaskId(taskId);

    if (!task) {
      throw new AppError("TASK_NOT_FOUND", 404, `Task ${taskId} not found`);
    }

    const session = this.deps.toolSessionRepository.findBySessionId(task.sessionId);
    const messages = this.deps.messageRepository.listByTaskId(task.taskId);
    const risks = this.deps.riskConfirmationRepository.listByTaskId(task.taskId);
    const audits = this.deps.auditLogRepository.listByTaskId(task.taskId);
    const taskTitle = deriveTaskTitle(task, messages);

    return {
      taskId: task.taskId,
      sessionId: task.sessionId,
      taskTitle,
      status: task.status,
      summary: task.summary ?? taskTitle ?? "",
      sourcePlatform: messages[0]?.sourcePlatform ?? "feishu",
      toolProvider: session?.toolProvider ?? "codex",
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      messageTimeline: messages.map((message) => ({
        eventId: message.eventId,
        direction: message.direction,
        sourcePlatform: message.sourcePlatform,
        senderId: message.senderId,
        messageType: message.messageType,
        status: message.status,
        summary: message.content,
        rawContent: message.content,
        createdAt: message.createdAt
      })),
      riskRecords: risks.map((risk) => ({
        confirmationToken: risk.confirmationToken,
        requestedBy: risk.requestedBy,
        status: risk.status,
        expiredAt: risk.expiredAt,
        confirmedBy: risk.confirmedBy,
        confirmedAt: risk.confirmedAt
      })),
      auditLogs: audits.map((audit) => ({
        eventId: audit.eventId,
        action: audit.action,
        actorId: audit.actorId,
        result: audit.result,
        detail: audit.detail,
        createdAt: audit.createdAt
      }))
    };
  }
}
