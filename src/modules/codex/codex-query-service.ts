/**
 * @description 提供 Codex 会话与任务列表查询能力，支持状态筛选和进行中视图
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-26 18:20
 */
import { AppError } from "../../lib/errors";
import { deriveTaskTitle, summarizeText } from "../common/display";
import { AuditLogRepository } from "../../storage/repositories/audit-log-repository";
import { MessageRepository } from "../../storage/repositories/message-repository";
import { TaskRepository } from "../../storage/repositories/task-repository";
import { ToolSessionRepository } from "../../storage/repositories/tool-session-repository";

export type CodexListQueryInput = {
  limit: number;
  statuses: string[];
  sinceAt?: string;
};

type CodexQueryServiceDeps = {
  toolSessionRepository: ToolSessionRepository;
  taskRepository: TaskRepository;
  messageRepository: MessageRepository;
  auditLogRepository: AuditLogRepository;
};

export class CodexQueryService {
  constructor(private readonly deps: CodexQueryServiceDeps) {}

  listSessions(input: CodexListQueryInput) {
    const sessions =
      input.statuses.length > 0
        ? this.deps.toolSessionRepository.listByToolProviderAndStatuses("codex", input.statuses, input.limit, input.sinceAt)
        : this.deps.toolSessionRepository.listByToolProvider("codex", input.limit, input.sinceAt);

    return {
      items: sessions.map((session) => {
        const latestTask = this.deps.taskRepository.findManyBySessionId(session.sessionId, 1)[0] ?? null;
        const latestMessage = this.deps.messageRepository.findLatestBySessionId(session.sessionId);

        return {
          sessionId: session.sessionId,
          toolSessionRef: session.toolSessionRef,
          status: session.status,
          createdBy: session.createdBy,
          updatedAt: session.updatedAt,
          latestTaskId: latestTask?.taskId ?? null,
          latestTaskStatus: latestTask?.status ?? null,
          latestTaskSummary: summarizeText(latestTask?.summary ?? "", 120),
          latestMessageSummary: summarizeText(latestMessage?.content ?? "", 120)
        };
      })
    };
  }

  listTasks(input: CodexListQueryInput) {
    const candidateLimit = Math.max(input.limit * 3, input.limit);
    const candidates = this.deps.taskRepository.listByToolProviderAndStatuses(
      "codex",
      input.statuses,
      candidateLimit,
      input.sinceAt
    );

    const items: Array<{
      taskId: string;
      sessionId: string;
      taskTitle: string | null;
      status: string;
      summary: string;
      startedAt: string;
      finishedAt: string | null;
      updatedAt: string;
      createdBy: string | null;
      toolSessionRef: string;
    }> = [];

    for (const task of candidates) {
      if (items.length >= input.limit) {
        break;
      }
      const session = this.deps.toolSessionRepository.findBySessionId(task.sessionId);
      if (!session) {
        continue;
      }

      const messages = this.deps.messageRepository.listByTaskId(task.taskId);
      const taskTitle = deriveTaskTitle(task, messages);
      const latestMessage = messages.at(-1);

      items.push({
        taskId: task.taskId,
        sessionId: task.sessionId,
        taskTitle,
        status: task.status,
        summary: summarizeText(task.summary ?? latestMessage?.content ?? taskTitle ?? "", 160),
        startedAt: task.startedAt,
        finishedAt: task.finishedAt,
        updatedAt: latestMessage?.createdAt ?? task.finishedAt ?? task.startedAt,
        createdBy: session.createdBy,
        toolSessionRef: session.toolSessionRef
      });
    }

    return {
      items
    };
  }

  getOverview(input: { taskLimit: number; sessionLimit: number; sinceHours?: number }) {
    const sinceAt = input.sinceHours
      ? new Date(Date.now() - input.sinceHours * 60 * 60 * 1000).toISOString()
      : undefined;
    const activeTaskStatuses = ["running"];
    const activeSessionStatuses = ["running", "waiting_confirm", "paused"];
    const totalSessions = this.deps.toolSessionRepository.countByToolProviderAndStatuses("codex", [], sinceAt);
    const activeSessions = this.deps.toolSessionRepository.countByToolProviderAndStatuses(
      "codex",
      activeSessionStatuses,
      sinceAt
    );

    return {
      summary: {
        runningTaskCount: this.deps.taskRepository.countByToolProviderAndStatuses("codex", ["running"], sinceAt),
        succeededTaskCount: this.deps.taskRepository.countByToolProviderAndStatuses("codex", ["succeeded"], sinceAt),
        failedTaskCount: this.deps.taskRepository.countByToolProviderAndStatuses("codex", ["failed"], sinceAt),
        activeSessionCount: activeSessions,
        closedSessionCount: Math.max(totalSessions - activeSessions, 0)
      },
      activeTasks: this.listTasks({
        limit: input.taskLimit,
        statuses: activeTaskStatuses,
        sinceAt
      }).items,
      recentSessions: this.listSessions({
        limit: input.sessionLimit,
        statuses: [],
        sinceAt
      }).items,
      sinceAt: sinceAt ?? null,
      sinceHours: input.sinceHours ?? null,
      updatedAt: new Date().toISOString()
    };
  }

  getTaskEvents(input: { taskId: string; limit: number }) {
    const task = this.deps.taskRepository.findByTaskId(input.taskId);
    if (!task) {
      throw new AppError("CODEX_TASK_NOT_FOUND", 404, `Codex task ${input.taskId} not found`);
    }

    const session = this.deps.toolSessionRepository.findBySessionId(task.sessionId);
    if (!session || session.toolProvider !== "codex") {
      throw new AppError("CODEX_TASK_NOT_FOUND", 404, `Codex task ${input.taskId} not found`);
    }

    const messages = this.deps.messageRepository.listByTaskId(task.taskId);
    const audits = this.deps.auditLogRepository.listByTaskId(task.taskId);

    const events: Array<{
      timestamp: string;
      type: "task_status" | "message" | "audit";
      event: string;
      status: string | null;
      actorId: string | null;
      source: string | null;
      detail: string | null;
      direction: string | null;
      result: string | null;
      eventId: string | null;
    }> = [
      {
        timestamp: task.startedAt,
        type: "task_status",
        event: "started",
        status: "running",
        actorId: session.createdBy,
        source: "gateway",
        detail: task.summary,
        direction: null,
        result: null,
        eventId: task.triggerMessageId
      }
    ];

    if (task.finishedAt) {
      events.push({
        timestamp: task.finishedAt,
        type: "task_status",
        event: "finished",
        status: task.status,
        actorId: null,
        source: "gateway",
        detail: task.summary,
        direction: null,
        result: null,
        eventId: null
      });
    }

    for (const message of messages) {
      events.push({
        timestamp: message.createdAt,
        type: "message",
        event: message.messageType,
        status: message.status,
        actorId: message.senderId,
        source: message.sourcePlatform,
        detail: message.content,
        direction: message.direction,
        result: null,
        eventId: message.eventId
      });
    }

    for (const audit of audits) {
      events.push({
        timestamp: audit.createdAt,
        type: "audit",
        event: audit.action,
        status: null,
        actorId: audit.actorId,
        source: "audit_log",
        detail: audit.detail,
        direction: null,
        result: audit.result,
        eventId: audit.eventId
      });
    }

    const sorted = events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const limited = sorted.slice(-input.limit);

    return {
      taskId: task.taskId,
      sessionId: task.sessionId,
      status: task.status,
      items: limited
    };
  }
}
