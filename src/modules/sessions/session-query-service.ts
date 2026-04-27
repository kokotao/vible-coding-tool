import { AppError } from "../../lib/errors";
import { deriveTaskTitle } from "../common/display";
import { AuditLogRepository } from "../../storage/repositories/audit-log-repository";
import { MessageRepository } from "../../storage/repositories/message-repository";
import { TaskRepository } from "../../storage/repositories/task-repository";
import { ToolSessionRepository } from "../../storage/repositories/tool-session-repository";

export type SessionQueryServiceDeps = {
  toolSessionRepository: ToolSessionRepository;
  taskRepository: TaskRepository;
  messageRepository: MessageRepository;
  auditLogRepository: AuditLogRepository;
};

export class SessionQueryService {
  constructor(private readonly deps: SessionQueryServiceDeps) {}

  getSessionDetail(sessionId: string) {
    const session = this.deps.toolSessionRepository.findBySessionId(sessionId);

    if (!session) {
      throw new AppError("SESSION_NOT_FOUND", 404, `Session ${sessionId} not found`);
    }

    const tasks = this.deps.taskRepository.findManyBySessionId(sessionId, 10);
    const messages = this.deps.messageRepository.listBySessionId(sessionId, 20).reverse();
    const audits = this.deps.auditLogRepository.listBySessionId(sessionId, 20);

    return {
      sessionId: session.sessionId,
      toolProvider: session.toolProvider,
      toolSessionRef: session.toolSessionRef,
      status: session.status,
      createdBy: session.createdBy,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      recentTasks: tasks.map((task) => ({
        taskId: task.taskId,
        taskTitle: deriveTaskTitle(task, this.deps.messageRepository.listByTaskId(task.taskId)),
        status: task.status,
        summary: task.summary,
        startedAt: task.startedAt,
        finishedAt: task.finishedAt
      })),
      messageTimeline: messages.map((message) => ({
        eventId: message.eventId,
        taskId: message.taskId,
        direction: message.direction,
        messageType: message.messageType,
        rawContent: message.content,
        createdAt: message.createdAt
      })),
      bindings: {
        sessionPrefix: session.sessionId.split("-").slice(0, 2).join("-"),
        defaultChannelName: null
      },
      auditLogs: audits.map((audit) => ({
        eventId: audit.eventId,
        taskId: audit.taskId,
        action: audit.action,
        result: audit.result,
        createdAt: audit.createdAt
      }))
    };
  }
}
