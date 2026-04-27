/**
 * @description 处理 Codex 事件入站，同步任务状态并自动回推飞书
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-26 18:20
 */
import { randomUUID } from "node:crypto";
import { FeishuOutboundNotifier } from "../notifications/feishu-outbound-notifier";
import { AuditLogRepository } from "../../storage/repositories/audit-log-repository";
import { IdempotencyRepository } from "../../storage/repositories/idempotency-repository";
import { MessageRepository } from "../../storage/repositories/message-repository";
import { SessionThreadRepository } from "../../storage/repositories/session-thread-repository";
import { TaskRepository, type TaskRecord } from "../../storage/repositories/task-repository";
import { ToolSessionRepository } from "../../storage/repositories/tool-session-repository";

type CodexEventServiceDeps = {
  taskRepository: TaskRepository;
  messageRepository: MessageRepository;
  toolSessionRepository: ToolSessionRepository;
  auditLogRepository: AuditLogRepository;
  idempotencyRepository: IdempotencyRepository;
  sessionThreadRepository: SessionThreadRepository;
  feishuNotifier?: FeishuOutboundNotifier;
};

export type CodexStatus = "running" | "succeeded" | "failed";

export type CodexInboundEvent = {
  eventId?: string;
  taskId?: string;
  sessionId: string;
  toolSessionRef?: string;
  status: CodexStatus;
  summary?: string;
  detail?: string;
  senderId?: string;
  occurredAt?: string;
};

export class CodexEventService {
  constructor(private readonly deps: CodexEventServiceDeps) {}

  async handleEvent(event: CodexInboundEvent) {
    const now = event.occurredAt ?? new Date().toISOString();
    const senderId = event.senderId?.trim() || "codex_runtime";
    const senderOpenId = this.parseOpenId(senderId);

    if (event.eventId) {
      const isNew = this.deps.idempotencyRepository.saveIfAbsent({
        idempotencyKey: `codex:event:${event.eventId}`,
        scope: "codex_event",
        createdAt: now
      });

      if (!isNew) {
        return {
          accepted: true,
          duplicate: true,
          eventId: event.eventId,
          message: "Duplicate codex event ignored"
        };
      }
    }

    const task = this.findOrCreateTask(event, now);
    const summary = this.resolveSummary(event, task);
    const finishedAt = this.resolveFinishedAt(event.status, now);

    const updatedTask =
      this.deps.taskRepository.updateStatusAndSummary(task.taskId, event.status, finishedAt, summary) ?? task;
    const existingSession = this.deps.toolSessionRepository.findBySessionId(updatedTask.sessionId);
    const eventThreadRef = this.resolveThreadRefFromEvent(event);
    const sessionThreadRef = this.isThreadRef(existingSession?.toolSessionRef || "")
      ? (existingSession?.toolSessionRef as string)
      : null;
    const resolvedThreadRef = eventThreadRef || sessionThreadRef;
    const threadBinding = resolvedThreadRef
      ? this.deps.sessionThreadRepository.upsertByEvent({
          sessionId: updatedTask.sessionId,
          threadRef: resolvedThreadRef,
          taskId: updatedTask.taskId,
          summary,
          seenAt: now
        })
      : null;

    const sessionStatus = this.mapSessionStatus(event.status);

    if (existingSession) {
      const existingOpenId = this.parseOpenId(existingSession.createdBy);
      this.deps.toolSessionRepository.upsert({
        ...existingSession,
        toolSessionRef: resolvedThreadRef || existingSession.toolSessionRef,
        status: sessionStatus,
        createdBy: existingOpenId ?? senderOpenId ?? existingSession.createdBy,
        updatedAt: now
      });
    } else {
      this.deps.toolSessionRepository.create({
        sessionId: updatedTask.sessionId,
        toolProvider: "codex",
        toolSessionRef: resolvedThreadRef || updatedTask.sessionId,
        status: sessionStatus,
        createdBy: senderOpenId,
        createdAt: now,
        updatedAt: now
      });
    }

    this.deps.messageRepository.create({
      eventId: randomUUID(),
      sessionId: updatedTask.sessionId,
      direction: "tool_to_bot",
      sourcePlatform: "codex",
      platformMessageId: event.eventId ?? null,
      senderId,
      content: summary,
      messageType: "tool_event",
      riskLevel: "low",
      status: event.status,
      taskId: updatedTask.taskId,
      createdAt: now
    });

    this.deps.auditLogRepository.create({
      eventId: event.eventId ?? randomUUID(),
      taskId: updatedTask.taskId,
      sessionId: updatedTask.sessionId,
      action: "codex_event_sync",
      actorId: senderId,
      result: "success",
      detail: `status=${event.status}; summary=${summary}`,
      createdAt: now
    });

    const notify = await this.notifyTaskStatus({
      taskId: updatedTask.taskId,
      sessionId: updatedTask.sessionId,
      status: event.status,
      summary,
      taskTitle: event.summary?.trim() || summary,
      detail: event.detail?.trim() || null,
      actorId: senderId,
      recipientOpenId: this.resolveRecipientOpenId(updatedTask.sessionId, senderOpenId),
      threadAlias: threadBinding?.threadAlias ?? null,
      threadRef: resolvedThreadRef
    });

    return {
      accepted: true,
      duplicate: false,
      eventId: event.eventId ?? null,
      taskId: updatedTask.taskId,
      sessionId: updatedTask.sessionId,
      status: updatedTask.status,
      notify
    };
  }

  private findOrCreateTask(event: CodexInboundEvent, now: string) {
    const normalizedTaskId = event.taskId?.trim() || null;

    if (normalizedTaskId) {
      const existing = this.deps.taskRepository.findByTaskId(normalizedTaskId);
      if (existing) {
        return existing;
      }

      const summary = this.resolveSummary(event, null);
      const finishedAt = this.resolveFinishedAt(event.status, now);
      const created = this.deps.taskRepository.create({
        taskId: normalizedTaskId,
        sessionId: event.sessionId,
        triggerMessageId: event.eventId ?? null,
        taskType: "codex_event",
        status: event.status,
        summary,
        startedAt: now,
        finishedAt
      });

      return created!;
    }

    const latestBySession = this.deps.taskRepository.findManyBySessionId(event.sessionId, 1)[0];
    if (latestBySession) {
      return latestBySession;
    }

    const taskId = randomUUID();
    const summary = this.resolveSummary(event, null);
    const finishedAt = this.resolveFinishedAt(event.status, now);

    const created = this.deps.taskRepository.create({
      taskId,
      sessionId: event.sessionId,
      triggerMessageId: event.eventId ?? null,
      taskType: "codex_event",
      status: event.status,
      summary,
      startedAt: now,
      finishedAt
    });

    return created!;
  }

  private resolveSummary(event: CodexInboundEvent, task: TaskRecord | null) {
    const summary = event.summary?.trim() || event.detail?.trim();
    if (summary) {
      return summary;
    }

    if (task?.summary?.trim()) {
      return task.summary.trim();
    }

    return `Codex task status changed to ${event.status}`;
  }

  private resolveFinishedAt(status: CodexStatus, now: string) {
    if (status === "succeeded" || status === "failed") {
      return now;
    }

    return null;
  }

  private resolveThreadRefFromEvent(event: CodexInboundEvent) {
    const explicit = (event.toolSessionRef || "").trim();
    if (this.isThreadRef(explicit)) {
      return explicit;
    }

    const eventId = (event.eventId || "").trim();
    const eventMatched = eventId.match(/codex-watch-complete-([0-9a-fA-F-]{36})-/);
    if (eventMatched && this.isThreadRef(eventMatched[1])) {
      return eventMatched[1];
    }

    return null;
  }

  private isThreadRef(value: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
  }

  private mapSessionStatus(status: CodexStatus) {
    if (status === "running") {
      return "running";
    }

    return "closed";
  }

  private resolveRecipientOpenId(sessionId: string, fallbackOpenId: string | null) {
    const session = this.deps.toolSessionRepository.findBySessionId(sessionId);
    const sessionOpenId = this.parseOpenId(session?.createdBy);
    return sessionOpenId ?? fallbackOpenId;
  }

  private parseOpenId(value: string | null | undefined) {
    const normalized = (value || "").trim();
    if (/^ou_[a-zA-Z0-9_-]+$/.test(normalized)) {
      return normalized;
    }

    return null;
  }

  private async notifyTaskStatus(input: {
    taskId: string;
    sessionId: string;
    status: string;
    summary: string;
    taskTitle?: string | null;
    detail?: string | null;
    actorId: string;
    recipientOpenId: string | null;
    threadAlias?: string | null;
    threadRef?: string | null;
  }) {
    if (!this.deps.feishuNotifier) {
      return {
        sent: false,
        skipped: true,
        reason: "notifier_disabled",
        statusCode: null
      };
    }

    return this.deps.feishuNotifier.notifyTaskStatus(input);
  }
}
