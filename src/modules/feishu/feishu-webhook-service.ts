/**
 * @description 处理飞书消息入站，完成 session 路由、任务入库和风险确认创建
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-26 09:26
 */
import { randomUUID } from "node:crypto";
import { AppError } from "../../lib/errors";
import { parseFeishuCommand } from "./feishu-message-parser";
import { evaluateRisk } from "../risk/risk-guard";
import { CodexDispatchService } from "../codex/codex-dispatch-service";
import { ConnectorConfigService } from "../connectors/connector-config-service";
import { FeishuOutboundNotifier } from "../notifications/feishu-outbound-notifier";
import { IdempotencyRepository } from "../../storage/repositories/idempotency-repository";
import { MessageRepository } from "../../storage/repositories/message-repository";
import { RiskConfirmationRepository } from "../../storage/repositories/risk-confirmation-repository";
import { SessionThreadRepository } from "../../storage/repositories/session-thread-repository";
import { TaskRepository } from "../../storage/repositories/task-repository";
import { ToolSessionRepository } from "../../storage/repositories/tool-session-repository";

type FeishuWebhookServiceDeps = {
  taskRepository: TaskRepository;
  messageRepository: MessageRepository;
  riskConfirmationRepository: RiskConfirmationRepository;
  toolSessionRepository: ToolSessionRepository;
  sessionThreadRepository: SessionThreadRepository;
  connectorConfigService: ConnectorConfigService;
  idempotencyRepository: IdempotencyRepository;
  codexDispatchService?: CodexDispatchService;
  feishuNotifier?: FeishuOutboundNotifier;
};

type FeishuIncomingMessage = {
  senderId: string;
  messageId: string | null;
  eventId: string | null;
  text: string;
};

export class FeishuWebhookService {
  constructor(private readonly deps: FeishuWebhookServiceDeps) {}

  async handleIncomingMessage(message: FeishuIncomingMessage) {
    const parsed = parseFeishuCommand({
      text: message.text,
      senderId: message.senderId,
      messageId: message.messageId
    });

    const connectorConfig = this.deps.connectorConfigService.getConfig("feishu");
    const sessionId = this.resolveSessionId(parsed.sessionId, parsed.senderId, connectorConfig.sessionPrefix);
    const threadRef = this.resolveThreadRef(sessionId, parsed.threadSelector);
    const now = new Date().toISOString();
    const idempotencyKey = `feishu:webhook:${message.messageId || message.eventId || parsed.senderId}:${sessionId}`;
    const isNewEvent = this.deps.idempotencyRepository.saveIfAbsent({
      idempotencyKey,
      scope: "feishu_webhook",
      createdAt: now
    });

    if (!isNewEvent) {
      return {
        accepted: true,
        duplicate: true,
        sessionId,
        riskLevel: "low",
        pendingConfirmation: false,
        message: "Duplicate event ignored"
      };
    }

    const risk = evaluateRisk(parsed.prompt, connectorConfig.riskKeywords);
    const taskId = randomUUID();
    const eventId = randomUUID();
    const existingSession = this.deps.toolSessionRepository.findBySessionId(sessionId);
    const toolSessionRef = threadRef || existingSession?.toolSessionRef || sessionId;

    this.deps.toolSessionRepository.upsert({
      sessionId,
      toolProvider: "codex",
      toolSessionRef,
      status: risk.level === "high" ? "waiting_confirm" : "running",
      createdBy: parsed.senderId,
      createdAt: now,
      updatedAt: now
    });

    this.deps.taskRepository.create({
      taskId,
      sessionId,
      triggerMessageId: eventId,
      taskType: "command",
      status: risk.level === "high" ? "pending_confirm" : "running",
      summary: parsed.prompt,
      startedAt: now,
      finishedAt: null
    });

    this.deps.messageRepository.create({
      eventId,
      sessionId,
      direction: "bot_to_tool",
      sourcePlatform: parsed.sourcePlatform,
      platformMessageId: parsed.platformMessageId,
      senderId: parsed.senderId,
      content: parsed.prompt,
      messageType: "command",
      riskLevel: risk.level,
      status: risk.level === "high" ? "pending_confirm" : "running",
      taskId,
      createdAt: now
    });

    if (risk.level === "high") {
      const expiredAt = new Date(Date.now() + connectorConfig.confirmTimeoutSeconds * 1000).toISOString();
      this.deps.riskConfirmationRepository.create({
        taskId,
        sessionId,
        requestedBy: parsed.senderId,
        confirmationToken: randomUUID(),
        status: "pending",
        expiredAt,
        confirmedBy: null,
        confirmedAt: null
      });
    }

    const status = risk.level === "high" ? "pending_confirm" : "running";
    const notify = await this.notifyTaskStatus({
      taskId,
      sessionId,
      status,
      summary: parsed.prompt,
      taskTitle: parsed.prompt,
      detail: parsed.prompt,
      actorId: parsed.senderId,
      recipientOpenId: parsed.senderId,
      threadRef
    });

    const dispatch =
      risk.level === "high"
        ? {
            accepted: false,
            skipped: true,
            reason: "pending_confirmation",
            pid: null,
            threadRef
          }
        : this.dispatchTask({
            taskId,
            sessionId,
            prompt: parsed.prompt,
            actorId: parsed.senderId,
            threadRef
          });

    return {
      accepted: true,
      sessionId,
      taskId,
      riskLevel: risk.level,
      pendingConfirmation: risk.level === "high",
      message: risk.level === "high" ? "High risk command pending confirmation" : "Command accepted",
      threadRef,
      notify,
      dispatch
    };
  }

  private resolveSessionId(explicitSessionId: string | null, senderId: string, fallbackSessionPrefix: string) {
    const explicit = (explicitSessionId || "").trim();
    if (explicit) {
      return explicit;
    }

    const latestSession = this.deps.messageRepository.findLatestSessionIdBySender(senderId, "feishu");
    if (latestSession) {
      return latestSession;
    }

    const fallback = (fallbackSessionPrefix || "").trim();
    if (fallback) {
      return fallback;
    }

    throw new AppError("SESSION_REQUIRED", 400, "First message must include #session:<id>");
  }

  private resolveThreadRef(sessionId: string, threadSelector: string | null) {
    const selector = (threadSelector || "").trim();
    if (!selector) {
      return null;
    }

    const uuidMatched = selector.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
    if (uuidMatched) {
      return uuidMatched[0];
    }

    const direct = this.deps.sessionThreadRepository.findBySessionAndRef(sessionId, selector);
    if (direct) {
      return direct.threadRef;
    }

    const primaryToken = selector.split(/[,\s-]/).find((token) => token.trim()) || selector;
    const prefixCandidates = [
      ...this.deps.sessionThreadRepository.findBySessionAndRefPrefix(sessionId, selector),
      ...this.deps.sessionThreadRepository.findBySessionAndRefPrefix(sessionId, primaryToken)
    ];

    const uniqueThreadRefs = [...new Set(prefixCandidates.map((item) => item.threadRef))];
    if (uniqueThreadRefs.length === 1) {
      return uniqueThreadRefs[0];
    }

    if (uniqueThreadRefs.length > 1) {
      throw new AppError("THREAD_SELECTOR_AMBIGUOUS", 409, "Thread selector matches multiple threads");
    }

    throw new AppError("THREAD_NOT_FOUND", 404, `Thread not found for selector: ${selector}`);
  }

  private dispatchTask(input: {
    taskId: string;
    sessionId: string;
    prompt: string;
    actorId: string;
    threadRef?: string | null;
  }) {
    if (!this.deps.codexDispatchService) {
      return {
        accepted: false,
        skipped: true,
        reason: "dispatcher_disabled",
        pid: null,
        threadRef: input.threadRef ?? null
      };
    }

    const result = this.deps.codexDispatchService.dispatchTask(input);
    return {
      accepted: result.accepted,
      skipped: result.skipped,
      reason: result.reason,
      pid: result.pid,
      threadRef: result.threadRef
    };
  }

  private async notifyTaskStatus(input: {
    taskId: string;
    sessionId: string;
    status: string;
    summary: string;
    taskTitle?: string | null;
    detail?: string | null;
    actorId: string;
    recipientOpenId?: string | null;
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
