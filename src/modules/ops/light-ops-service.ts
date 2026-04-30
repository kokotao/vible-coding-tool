/**
 * @description Provide light-weight ops actions: stop task, retry notification, and risk confirm/reject
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-26 18:20
 */
import { randomUUID } from "node:crypto";
import { AppError } from "../../lib/errors";
import { CodexDispatchService } from "../codex/codex-dispatch-service";
import { FeishuOutboundNotifier } from "../notifications/feishu-outbound-notifier";
import { QqOutboundNotifier } from "../notifications/qq-outbound-notifier";
import { AuditLogRepository } from "../../storage/repositories/audit-log-repository";
import { FeishuSessionRouteRepository } from "../../storage/repositories/feishu-session-route-repository";
import { MessageRepository } from "../../storage/repositories/message-repository";
import { RiskConfirmationRepository } from "../../storage/repositories/risk-confirmation-repository";
import { TaskRepository } from "../../storage/repositories/task-repository";
import { ToolSessionRepository } from "../../storage/repositories/tool-session-repository";

type LightOpsServiceDeps = {
  taskRepository: TaskRepository;
  riskConfirmationRepository: RiskConfirmationRepository;
  toolSessionRepository: ToolSessionRepository;
  messageRepository: MessageRepository;
  auditLogRepository: AuditLogRepository;
  feishuSessionRouteRepository: FeishuSessionRouteRepository;
  codexDispatchService?: CodexDispatchService;
  feishuNotifier?: FeishuOutboundNotifier;
  qqNotifier?: QqOutboundNotifier;
};

type LightOpsActorInput = {
  actorId?: string;
  sourcePlatform?: string;
};

const TERMINAL_TASK_STATUSES = new Set(["succeeded", "failed", "stopped", "rejected", "cancelled"]);

function normalizeActor(input?: LightOpsActorInput) {
  return {
    actorId: input?.actorId?.trim() || "web_console",
    sourcePlatform: input?.sourcePlatform?.trim() || "web_console"
  };
}

export class LightOpsService {
  constructor(private readonly deps: LightOpsServiceDeps) {}

  async stopTask(taskId: string, actorInput?: LightOpsActorInput) {
    const task = this.deps.taskRepository.findByTaskId(taskId);
    if (!task) {
      throw new AppError("TASK_NOT_FOUND", 404, `Task ${taskId} not found`);
    }

    if (TERMINAL_TASK_STATUSES.has(task.status)) {
      return {
        success: true,
        taskId: task.taskId,
        sessionId: task.sessionId,
        status: task.status,
        changed: false,
        message: "Task already finished"
      };
    }

    const actor = normalizeActor(actorInput);
    const now = new Date().toISOString();
    const stopControl = await this.deps.codexDispatchService?.interruptTask({
      taskId: task.taskId,
      sessionId: task.sessionId,
      actorId: actor.actorId
    });
    const stopDetail = (stopControl?.stopMessage || "").trim() || "Task terminated by operator";

    this.deps.taskRepository.updateStatus(task.taskId, "stopped", now);
    this.syncSessionStatus(task.sessionId, now, "paused");

    this.deps.messageRepository.create({
      eventId: randomUUID(),
      sessionId: task.sessionId,
      direction: "tool_to_bot",
      sourcePlatform: actor.sourcePlatform,
      platformMessageId: null,
      senderId: actor.actorId,
      content: `Task ${task.taskId} stopped\n${stopDetail}`,
      messageType: "manual_control",
      riskLevel: "low",
      status: "stopped",
      taskId: task.taskId,
      createdAt: now
    });

    this.deps.auditLogRepository.create({
      eventId: randomUUID(),
      taskId: task.taskId,
      sessionId: task.sessionId,
      action: "stop_task",
      actorId: actor.actorId,
      result: "success",
      detail: `Stopped via web console; stopMethod=${stopControl?.method || "none"}; stopAccepted=${stopControl?.accepted ?? false}; stopSucceeded=${stopControl?.stopped ?? false}`,
      createdAt: now
    });

    const notify = await this.notifyTaskStatus({
      taskId: task.taskId,
      sessionId: task.sessionId,
      status: "stopped",
      summary: "Task stopped",
      taskTitle: task.summary || task.taskId,
      detail: stopDetail,
      actorId: actor.actorId,
      recipient: this.resolveRecipientRoute(task.sessionId, actor.actorId)
    });

    return {
      success: true,
      taskId: task.taskId,
      sessionId: task.sessionId,
      status: "stopped",
      changed: true,
      message: "Task stopped",
      stoppedMessage: stopDetail,
      notify,
      stopControl
    };
  }


  async retryNotify(taskId: string, actorInput?: LightOpsActorInput) {
    const task = this.deps.taskRepository.findByTaskId(taskId);
    if (!task) {
      throw new AppError("TASK_NOT_FOUND", 404, `Task ${taskId} not found`);
    }

    const actor = normalizeActor(actorInput);
    const now = new Date().toISOString();

    this.deps.messageRepository.create({
      eventId: randomUUID(),
      sessionId: task.sessionId,
      direction: "tool_to_bot",
      sourcePlatform: actor.sourcePlatform,
      platformMessageId: null,
      senderId: actor.actorId,
      content: `Task ${task.taskId} retry notification requested; current status: ${task.status}`,
      messageType: "manual_notify",
      riskLevel: "low",
      status: "queued",
      taskId: task.taskId,
      createdAt: now
    });

    this.deps.auditLogRepository.create({
      eventId: randomUUID(),
      taskId: task.taskId,
      sessionId: task.sessionId,
      action: "retry_notify",
      actorId: actor.actorId,
      result: "success",
      detail: "Manual retry notification enqueued",
      createdAt: now
    });

    const notifyText = `Manual retry notify\nTask=${task.taskId}\nSession=${task.sessionId}\nStatus=${task.status}`;
    const notifyTarget = this.resolveRecipientRoute(task.sessionId, actor.actorId);
    const notify = await this.notifyText(notifyText, notifyTarget);

    return {
      success: true,
      taskId: task.taskId,
      sessionId: task.sessionId,
      status: task.status,
      message: "Retry notification queued",
      notify
    };
  }

  async confirmRisk(confirmationToken: string, actorInput?: LightOpsActorInput) {
    return this.handleRiskDecision(confirmationToken, "approved", "running", null, "risk_confirm", actorInput);
  }

  async rejectRisk(confirmationToken: string, actorInput?: LightOpsActorInput) {
    const now = new Date().toISOString();
    return this.handleRiskDecision(confirmationToken, "rejected", "rejected", now, "risk_reject", actorInput);
  }

  private async handleRiskDecision(
    confirmationToken: string,
    riskStatus: "approved" | "rejected",
    taskStatus: "running" | "rejected",
    finishedAt: string | null,
    auditAction: "risk_confirm" | "risk_reject",
    actorInput?: LightOpsActorInput
  ) {
    const risk = this.deps.riskConfirmationRepository.findByToken(confirmationToken);
    if (!risk) {
      throw new AppError("RISK_CONFIRMATION_NOT_FOUND", 404, `Risk confirmation ${confirmationToken} not found`);
    }

    if (risk.status !== "pending") {
      throw new AppError("RISK_CONFIRMATION_ALREADY_HANDLED", 409, `Risk confirmation ${confirmationToken} already handled`);
    }

    const actor = normalizeActor(actorInput);
    const now = new Date().toISOString();
    const task = this.deps.taskRepository.findByTaskId(risk.taskId);

    this.deps.riskConfirmationRepository.updateDecisionByToken(confirmationToken, riskStatus, actor.actorId, now);

    if (task) {
      this.deps.taskRepository.updateStatus(task.taskId, taskStatus, finishedAt);
    }

    this.deps.toolSessionRepository.updateStatus(
      risk.sessionId,
      riskStatus === "approved" ? "running" : "closed",
      now
    );

    this.deps.messageRepository.create({
      eventId: randomUUID(),
      sessionId: risk.sessionId,
      direction: "tool_to_bot",
      sourcePlatform: actor.sourcePlatform,
      platformMessageId: null,
      senderId: actor.actorId,
      content:
        riskStatus === "approved"
          ? `High risk command approved; task ${risk.taskId} resumed`
          : `High risk command rejected; task ${risk.taskId} terminated`,
      messageType: "risk_decision",
      riskLevel: "high",
      status: riskStatus === "approved" ? "running" : "rejected",
      taskId: risk.taskId,
      createdAt: now
    });

    this.deps.auditLogRepository.create({
      eventId: randomUUID(),
      taskId: risk.taskId,
      sessionId: risk.sessionId,
      action: auditAction,
      actorId: actor.actorId,
      result: "success",
      detail: `Decision ${riskStatus} via web console`,
      createdAt: now
    });

    const notify = await this.notifyTaskStatus({
      taskId: risk.taskId,
      sessionId: risk.sessionId,
      status: taskStatus,
      summary: riskStatus === "approved" ? "High risk command approved and resumed" : "High risk command rejected",
      taskTitle: task?.summary || risk.taskId,
      detail: riskStatus === "approved" ? "High risk command approved and resumed" : "High risk command rejected",
      actorId: actor.actorId,
      recipient: this.resolveRecipientRoute(risk.sessionId, actor.actorId)
    });

    const dispatch =
      riskStatus === "approved" && task
        ? this.dispatchTask({
            taskId: task.taskId,
            sessionId: task.sessionId,
            prompt: task.summary || "",
            actorId: actor.actorId
          })
        : {
            accepted: false,
            skipped: true,
            reason: "not_required",
            pid: null,
            threadRef: null
          };

    return {
      success: true,
      taskId: risk.taskId,
      sessionId: risk.sessionId,
      riskStatus,
      taskStatus,
      message: riskStatus === "approved" ? "Risk confirmation approved" : "Risk confirmation rejected",
      notify,
      dispatch
    };
  }

  private dispatchTask(input: { taskId: string; sessionId: string; prompt: string; actorId: string }) {
    if (!this.deps.codexDispatchService) {
      return {
        accepted: false,
        skipped: true,
        reason: "dispatcher_disabled",
        pid: null,
        threadRef: null
      };
    }

    return this.deps.codexDispatchService.dispatchTask(input);
  }

  private syncSessionStatus(sessionId: string, now: string, fallbackStatus: string) {
    const activeCount = this.deps.taskRepository.countActiveBySessionId(sessionId);
    if (activeCount === 0) {
      this.deps.toolSessionRepository.updateStatus(sessionId, fallbackStatus, now);
    }
  }

  private async notifyTaskStatus(input: {
    taskId: string;
    sessionId: string;
    status: string;
    summary: string;
    taskTitle?: string | null;
    detail?: string | null;
    actorId: string;
    recipient:
      | { sourcePlatform: "feishu"; recipientOpenId: string | null; recipientChatId?: string | null }
      | { sourcePlatform: "qq"; recipientUserId: string | null; recipientGroupId?: string | null };
  }) {
    if (input.recipient.sourcePlatform === "qq") {
      if (!this.deps.qqNotifier) {
        return {
          sent: false,
          skipped: true,
          reason: "notifier_disabled",
          statusCode: null
        };
      }
      return this.deps.qqNotifier.notifyTaskStatus({
        taskId: input.taskId,
        sessionId: input.sessionId,
        status: input.status,
        summary: input.summary,
        taskTitle: input.taskTitle,
        detail: input.detail,
        actorId: input.actorId,
        recipientUserId: input.recipient.recipientUserId,
        recipientGroupId: input.recipient.recipientGroupId
      });
    }

    if (!this.deps.feishuNotifier) {
      return {
        sent: false,
        skipped: true,
        reason: "notifier_disabled",
        statusCode: null
      };
    }

    return this.deps.feishuNotifier.notifyTaskStatus({
      taskId: input.taskId,
      sessionId: input.sessionId,
      status: input.status,
      summary: input.summary,
      taskTitle: input.taskTitle,
      detail: input.detail,
      actorId: input.actorId,
      recipientOpenId: input.recipient.recipientOpenId ?? null,
      recipientChatId: input.recipient.recipientChatId ?? null
    });
  }

  private async notifyText(
    text: string,
    recipient:
      | { sourcePlatform: "feishu"; recipientOpenId: string | null; recipientChatId?: string | null }
      | { sourcePlatform: "qq"; recipientUserId: string | null; recipientGroupId?: string | null }
  ) {
    if (recipient.sourcePlatform === "qq") {
      if (!this.deps.qqNotifier) {
        return {
          sent: false,
          skipped: true,
          reason: "notifier_disabled",
          statusCode: null
        };
      }
      return this.deps.qqNotifier.notifyText({
        text,
        recipientUserId: recipient.recipientUserId,
        recipientGroupId: recipient.recipientGroupId ?? null
      });
    }

    if (!this.deps.feishuNotifier) {
      return {
        sent: false,
        skipped: true,
        reason: "notifier_disabled",
        statusCode: null
      };
    }

    return this.deps.feishuNotifier.notifyText({
      text,
      recipientOpenId: recipient.recipientOpenId ?? null,
      recipientChatId: recipient.recipientChatId ?? null
    });
  }

  private resolveRecipientRoute(sessionId: string, actorId: string) {
    const route = this.deps.feishuSessionRouteRepository.findBySessionId(sessionId);
    if (route?.routeStatus === "active") {
      if (route.sourcePlatform === "feishu") {
        if (route.chatType === "group" && (route.chatId || "").trim()) {
          return {
            sourcePlatform: "feishu" as const,
            recipientOpenId: null,
            recipientChatId: route.chatId!.trim()
          };
        }

        if (this.isOpenId(route.senderOpenId)) {
          return {
            sourcePlatform: "feishu" as const,
            recipientOpenId: route.senderOpenId,
            recipientChatId: null
          };
        }
      }

      if (route.sourcePlatform === "qq") {
        return {
          sourcePlatform: "qq" as const,
          recipientUserId: route.senderOpenId,
          recipientGroupId: route.chatType === "group" ? (route.chatId || "").trim() || null : null
        };
      }
    }

    if (this.isOpenId(actorId)) {
      return {
        sourcePlatform: "feishu" as const,
        recipientOpenId: actorId,
        recipientChatId: null
      };
    }

    const session = this.deps.toolSessionRepository.findBySessionId(sessionId);
    if (session?.createdBy && this.isOpenId(session.createdBy)) {
      return {
        sourcePlatform: "feishu" as const,
        recipientOpenId: session.createdBy,
        recipientChatId: null
      };
    }

    return {
      sourcePlatform: "feishu" as const,
      recipientOpenId: null,
      recipientChatId: null
    };
  }

  private isOpenId(value: string) {
    return /^ou_[a-zA-Z0-9_-]+$/.test(value.trim());
  }
}
