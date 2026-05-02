/**
 * @description 处理飞书消息入站，完成 session 路由、任务入库和风险确认创建
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-26 09:26
 */
import { randomUUID } from "node:crypto";
import { AppError } from "../../lib/errors";
import {
  buildFeishuCommandHelpCard,
  buildFeishuCommandHelpPayload,
  buildFeishuCommandHelpText,
  isExplicitFeishuCommand,
  parseFeishuCommand,
  parseFeishuIdentityBindingCommand,
  type ParsedCommand,
  type ParsedIdentityBindingCommand
} from "./feishu-message-parser";
import { type FeishuPanelCommand } from "./feishu-command-panel";
import { FeishuCommandPanelService } from "./feishu-command-panel-service";
import { evaluateRisk } from "../risk/risk-guard";
import { CodexDispatchService } from "../codex/codex-dispatch-service";
import { CodexLocalSessionService } from "../codex/codex-local-session-service";
import { ConnectorConfigService } from "../connectors/connector-config-service";
import { FeishuIdentityService } from "./feishu-identity-service";
import { FeishuOutboundNotifier } from "../notifications/feishu-outbound-notifier";
import { LightOpsService } from "../ops/light-ops-service";
import { AuditLogRepository } from "../../storage/repositories/audit-log-repository";
import {
  FeishuSessionRouteRepository,
  type FeishuSessionRouteChatType
} from "../../storage/repositories/feishu-session-route-repository";
import { IdempotencyRepository } from "../../storage/repositories/idempotency-repository";
import { MessageRepository } from "../../storage/repositories/message-repository";
import { RiskConfirmationRepository } from "../../storage/repositories/risk-confirmation-repository";
import { SessionThreadRepository } from "../../storage/repositories/session-thread-repository";
import { TaskRepository } from "../../storage/repositories/task-repository";
import { ToolSessionRepository } from "../../storage/repositories/tool-session-repository";
import type { TerminalEventStream } from "../../lib/terminal-event-stream";

type FeishuWebhookServiceDeps = {
  taskRepository: TaskRepository;
  messageRepository: MessageRepository;
  riskConfirmationRepository: RiskConfirmationRepository;
  toolSessionRepository: ToolSessionRepository;
  sessionThreadRepository: SessionThreadRepository;
  auditLogRepository: AuditLogRepository;
  connectorConfigService: ConnectorConfigService;
  idempotencyRepository: IdempotencyRepository;
  feishuSessionRouteRepository: FeishuSessionRouteRepository;
  feishuIdentityService: FeishuIdentityService;
  feishuCommandPanelService?: FeishuCommandPanelService;
  codexDispatchService?: CodexDispatchService;
  feishuNotifier?: FeishuOutboundNotifier;
  codexLocalSessionService?: CodexLocalSessionService;
  lightOpsService?: LightOpsService;
  terminalEventStream?: TerminalEventStream;
};

type FeishuIncomingMessage = {
  senderId: string;
  messageId: string | null;
  eventId: string | null;
  text: string;
  chatId: string | null;
  chatType: FeishuSessionRouteChatType | null;
  mentioned: boolean;
  allowImplicitDispatch?: boolean;
};

export class FeishuWebhookService {
  constructor(private readonly deps: FeishuWebhookServiceDeps) {}

  async handleIncomingMessage(message: FeishuIncomingMessage) {
    const routeCheck = this.validateIncomingRoute(message);
    if (routeCheck.ignored) {
      return routeCheck;
    }

    const bindingCommand = parseFeishuIdentityBindingCommand(message.text);
    if (bindingCommand) {
      return this.handleIdentityBinding(message, bindingCommand);
    }

    const panelCommand = this.deps.feishuCommandPanelService?.parseCommand(message.text);
    if (panelCommand) {
      return this.handlePanelCommand(message, panelCommand);
    }

    if (!isExplicitFeishuCommand(message.text)) {
      const panelContext = this.deps.feishuCommandPanelService?.resolveDispatchContext(message.senderId);
      const prompt = message.text.trim();
      if (panelContext?.pendingComposeMode === "session_command") {
        if (!prompt) {
          return this.handleCommandGuidance(message, "ambiguous_command");
        }

        const parsed: ParsedCommand = {
          sessionId: panelContext.selectedThreadId || null,
          newSession: false,
          prompt,
          threadAlias: null,
          threadSelector: panelContext.selectedThreadId || null,
          sourcePlatform: "feishu",
          senderId: message.senderId,
          platformMessageId: message.messageId
        };

        return this.executeParsedCommand(
          message,
          parsed,
          panelContext.selectedModelSlug ?? null,
          panelContext.selectedReasoningLevel ?? null,
          panelContext.selectedProjectPath ?? null
        );
      }

      if (panelContext?.pendingComposeMode === "thread_command") {
        if (!prompt) {
          return this.handleCommandGuidance(message, "ambiguous_command");
        }

        if (!panelContext.selectedThreadId) {
          return this.handleCommandGuidance(message, "thread_not_found");
        }

        const parsed: ParsedCommand = {
          sessionId: panelContext.selectedThreadId,
          newSession: false,
          prompt,
          threadAlias: null,
          threadSelector: panelContext.selectedThreadId,
          sourcePlatform: "feishu",
          senderId: message.senderId,
          platformMessageId: message.messageId
        };

        return this.executeParsedCommand(
          message,
          parsed,
          panelContext.selectedModelSlug ?? null,
          panelContext.selectedReasoningLevel ?? null,
          panelContext.selectedProjectPath ?? null
        );
      }

      if (panelContext?.pendingComposeMode === "project_session_command") {
        if (!prompt) {
          return this.handleCommandGuidance(message, "ambiguous_command");
        }

        if (!panelContext.selectedProjectPath) {
          return this.handleCommandGuidance(message, "session_required");
        }

        const parsed: ParsedCommand = {
          sessionId: null,
          newSession: true,
          prompt,
          threadAlias: null,
          threadSelector: null,
          sourcePlatform: "feishu",
          senderId: message.senderId,
          platformMessageId: message.messageId
        };

        return this.executeParsedCommand(
          message,
          parsed,
          panelContext.selectedModelSlug ?? null,
          panelContext.selectedReasoningLevel ?? null,
          panelContext.selectedProjectPath ?? null
        );
      }

      if (panelContext?.selectedThreadId) {
        const parsed: ParsedCommand = {
          sessionId: panelContext.selectedThreadId,
          newSession: false,
          prompt,
          threadAlias: null,
          threadSelector: panelContext.selectedThreadId,
          sourcePlatform: "feishu",
          senderId: message.senderId,
          platformMessageId: message.messageId
        };

        return this.executeParsedCommand(
          message,
          parsed,
          panelContext.selectedModelSlug ?? null,
          panelContext.selectedReasoningLevel ?? null,
          panelContext.selectedProjectPath ?? null
        );
      }

      if (message.allowImplicitDispatch) {
        const prompt = message.text.trim();
        if (!prompt) {
          return this.handleCommandGuidance(message, "ambiguous_command");
        }

        const parsed: ParsedCommand = {
          sessionId: null,
          newSession: false,
          prompt,
          threadAlias: null,
          threadSelector: null,
          sourcePlatform: "feishu",
          senderId: message.senderId,
          platformMessageId: message.messageId
        };

        return this.executeParsedCommand(
          message,
          parsed,
          panelContext?.selectedModelSlug ?? null,
          panelContext?.selectedReasoningLevel ?? null,
          panelContext?.selectedProjectPath ?? null
        );
      }

      return this.handleCommandGuidance(message, "ambiguous_command");
    }

    let parsed: ParsedCommand;
    try {
      parsed = parseFeishuCommand({
        text: message.text,
        senderId: message.senderId,
        messageId: message.messageId
      });
    } catch (error) {
      if (error instanceof AppError && this.isCommandGuidanceError(error.code)) {
        return this.handleCommandGuidance(message, this.mapCommandGuidanceReason(error.code));
      }

      throw error;
    }

    const panelContext = this.deps.feishuCommandPanelService?.resolveDispatchContext(message.senderId);
    return this.executeParsedCommand(
      message,
      parsed,
      panelContext?.selectedModelSlug ?? null,
      panelContext?.selectedReasoningLevel ?? null,
      panelContext?.selectedProjectPath ?? null
    );
  }

  async handleCardAction(message: {
    senderId: string;
    messageId: string | null;
    eventId: string | null;
    action: { tag?: string; value?: unknown; name?: string; option?: string } | null;
    context: { open_message_id?: string; open_chat_id?: string } | null;
  }) {
    const panelCommand = this.deps.feishuCommandPanelService?.parseAction(message.action?.value);
    if (!panelCommand) {
      return {
        accepted: true,
        ignored: true,
        reason: "unsupported_card_action"
      };
    }

    return this.handlePanelCommand(
      {
        senderId: message.senderId,
        messageId: message.messageId,
        eventId: message.eventId,
        text: "",
        chatId: message.context?.open_chat_id || null,
        chatType: message.context?.open_chat_id ? "group" : null,
        mentioned: true
      },
      panelCommand,
      {
        refresh: false,
        awaitNotify: false
      }
    );
  }

  private async handleIdentityBinding(
    message: FeishuIncomingMessage,
    bindingCommand: ParsedIdentityBindingCommand
  ) {
    const now = new Date().toISOString();
    const idempotencyKey = `feishu:identity-bind:${message.messageId || message.eventId || message.senderId}`;
    const isNewEvent = this.deps.idempotencyRepository.saveIfAbsent({
      idempotencyKey,
      scope: "feishu_webhook",
      createdAt: now
    });

    if (!isNewEvent) {
      return {
        accepted: true,
        duplicate: true,
        message: "Duplicate identity binding ignored"
      };
    }

    const targetOpenId = bindingCommand.targetOpenId || message.senderId;
    const identity = this.deps.feishuIdentityService.bindDisplayName({
      openId: targetOpenId,
      displayName: bindingCommand.displayName,
      boundBy: message.senderId
    });
    if (!identity) {
      throw new AppError("FEISHU_IDENTITY_BIND_FAILED", 500, "Failed to bind Feishu identity");
    }

    const notify = await this.notifyIdentityBinding({
      senderId: message.senderId,
      chatId: message.chatId,
      chatType: message.chatType,
      displayName: identity.displayName,
      openId: identity.openId
    });

    await this.deps.auditLogRepository.create({
      eventId: randomUUID(),
      taskId: null,
      sessionId: `feishu-identity-${identity.openId}`,
      action: "feishu_identity_bind",
      actorId: message.senderId,
      result: notify.sent ? "success" : notify.skipped ? "skipped" : "failed",
      detail: `openId=${identity.openId}; displayName=${identity.displayName}; bindingSource=${identity.bindingSource}`,
      createdAt: now
    });

    return {
      accepted: true,
      message: `已绑定姓名：${identity.displayName}`,
      identity: {
        openId: identity.openId,
        displayName: identity.displayName,
        bindingSource: identity.bindingSource,
        boundBy: identity.boundBy
      },
      targetOpenId,
      notify
    };
  }

  private async handleCommandGuidance(message: FeishuIncomingMessage, reason: string) {
    const now = new Date().toISOString();
    const idempotencyKey = `feishu:command-guidance:${message.messageId || message.eventId || message.senderId}`;
    const isNewEvent = this.deps.idempotencyRepository.saveIfAbsent({
      idempotencyKey,
      scope: "feishu_webhook",
      createdAt: now
    });

    if (!isNewEvent) {
      return {
        accepted: false,
        skipped: true,
        duplicate: true,
        reason,
        message: buildFeishuCommandHelpText(this.normalizeCommandGuidanceReason(reason)),
        help: buildFeishuCommandHelpPayload(this.normalizeCommandGuidanceReason(reason))
      };
    }

    const guidanceReason = this.normalizeCommandGuidanceReason(reason);
    const notify = await this.notifyCommandGuidance({
      senderId: message.senderId,
      chatId: message.chatId,
      chatType: message.chatType,
      reason: guidanceReason
    });

    await this.deps.auditLogRepository.create({
      eventId: randomUUID(),
      taskId: null,
      sessionId: `feishu-command-guidance-${message.senderId}`,
      action: "feishu_command_guidance",
      actorId: message.senderId,
      result: this.normalizeNotifyResult(notify),
      detail: `reason=${guidanceReason}; sent=${notify.sent}; skipped=${notify.skipped}; statusCode=${notify.statusCode ?? "null"}`,
      createdAt: now
    });

    return {
      accepted: false,
      skipped: true,
      reason,
      message: buildFeishuCommandHelpText(guidanceReason),
      help: buildFeishuCommandHelpPayload(guidanceReason),
      notify
    };
  }

  private async handlePanelCommand(
    message: FeishuIncomingMessage,
    command: FeishuPanelCommand,
    input: {
      refresh?: boolean;
      awaitNotify?: boolean;
    } = {}
  ) {
    const panelService = this.deps.feishuCommandPanelService;
    if (!panelService) {
      return this.handleCommandGuidance(message, "ambiguous_command");
    }

    const refresh = input.refresh ?? true;
    const awaitNotify = input.awaitNotify ?? true;

    if (command.actionType === "help") {
      return this.handleCommandGuidance(message, "ambiguous_command");
    }

    if (command.actionType === "start_task") {
      const context = panelService.resolveDispatchContext(message.senderId);
      if (!context.selectedThreadId) {
        return this.handleCommandGuidance(message, "session_required");
      }

      const prompt = command.prompt.trim();
      if (!prompt) {
        return this.handleCommandGuidance(message, "ambiguous_command");
      }

      const parsed: ParsedCommand = {
        sessionId: context.selectedThreadId,
        newSession: false,
        prompt,
        threadAlias: null,
        threadSelector: context.selectedThreadId,
        sourcePlatform: "feishu",
        senderId: message.senderId,
        platformMessageId: message.messageId
      };

      return this.executeParsedCommand(
        message,
        parsed,
        context.selectedModelSlug ?? null,
        context.selectedReasoningLevel ?? null,
        context.selectedProjectPath ?? null
      );
    }

    if (command.actionType === "stop_task") {
      if (!this.deps.lightOpsService) {
        return {
          accepted: false,
          command: command.actionType,
          reason: "stop_service_disabled"
        };
      }

      const taskId = command.taskId.trim();
      if (!taskId) {
        return this.handleCommandGuidance(message, "ambiguous_command");
      }

      const operation = await this.deps.lightOpsService.stopTask(taskId, {
        actorId: message.senderId,
        sourcePlatform: "feishu"
      });
      const resolvedStopMessage =
        (operation as { stoppedMessage?: string | null }).stoppedMessage ||
        (operation as { stopControl?: { stopMessage?: string | null } }).stopControl?.stopMessage ||
        this.resolveLatestAssistantMessage(command.threadRef || command.sessionId || "") ||
        null;

      return {
        accepted: true,
        command: command.actionType,
        operation: {
          ...operation,
          stopMessage: resolvedStopMessage
        }
      };
    }

    const result = await panelService.handlePanelCommand(message.senderId, command, refresh);
    const replyTarget = this.resolveReplyTarget(message);
    const notifyInput = {
      card: result.card,
      recipientOpenId: replyTarget.recipientOpenId,
      recipientChatId: replyTarget.recipientChatId
    };

    if (!awaitNotify) {
      const auditCreatedAt = new Date().toISOString();
      void this.notifyCard(notifyInput)
        .then(async (notify) => {
          await this.deps.auditLogRepository.create({
            eventId: randomUUID(),
            taskId: null,
            sessionId: `feishu-panel-${message.senderId}`,
            action: "feishu_panel_notify_card",
            actorId: message.senderId,
            result: this.normalizeNotifyResult(notify),
            detail: `command=${command.actionType}; sent=${notify.sent}; skipped=${notify.skipped}; reason=${notify.reason || "null"}; statusCode=${notify.statusCode ?? "null"}; refresh=${refresh}; async=true`,
            createdAt: auditCreatedAt
          });
        })
        .catch(() => undefined);

      return {
        accepted: true,
        command: command.actionType,
        context: result.context,
        notify: {
          sent: false,
          skipped: true,
          reason: "queued_async",
          statusCode: null
        }
      };
    }

    const notify = await this.notifyCard(notifyInput);
    await this.deps.auditLogRepository.create({
      eventId: randomUUID(),
      taskId: null,
      sessionId: `feishu-panel-${message.senderId}`,
      action: "feishu_panel_notify_card",
      actorId: message.senderId,
      result: this.normalizeNotifyResult(notify),
      detail: `command=${command.actionType}; sent=${notify.sent}; skipped=${notify.skipped}; reason=${notify.reason || "null"}; statusCode=${notify.statusCode ?? "null"}; refresh=${refresh}; async=false`,
      createdAt: new Date().toISOString()
    });

    return {
      accepted: true,
      command: command.actionType,
      context: result.context,
      notify
    };
  }

  private async executeParsedCommand(
    message: FeishuIncomingMessage,
    parsed: ParsedCommand,
    selectedModelSlug: string | null,
    selectedReasoningLevel: string | null = null,
    selectedProjectPath: string | null = null
  ) {
    if (!parsed.prompt.trim()) {
      return this.handleCommandGuidance(message, "ambiguous_command");
    }

    const connectorConfig = this.deps.connectorConfigService.getConfig("feishu");
    let sessionId: string;
    let threadRef: string | null;
    try {
      sessionId = parsed.newSession
        ? randomUUID()
        : this.resolveSessionId({
            explicitSessionId: parsed.sessionId,
            senderId: parsed.senderId,
            chatType: message.chatType,
            chatId: message.chatId,
            fallbackSessionPrefix: connectorConfig.sessionPrefix
          });
      threadRef = this.resolveThreadRef(sessionId, parsed.threadSelector);
    } catch (error) {
      if (error instanceof AppError && this.isCommandGuidanceError(error.code)) {
        return this.handleCommandGuidance(message, this.mapCommandGuidanceReason(error.code));
      }

      throw error;
    }

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

    this.deps.terminalEventStream?.feishuCommandReceived({
      senderId: parsed.senderId,
      sessionId,
      threadRef,
      prompt: parsed.prompt,
      modelSlug: selectedModelSlug ?? null
    });

    const senderIdentity = await this.deps.feishuIdentityService.ensureAutoIdentity(parsed.senderId);
    const risk = evaluateRisk(parsed.prompt, connectorConfig.riskKeywords);
    const taskId = randomUUID();
    const eventId = randomUUID();
    const existingSession = this.deps.toolSessionRepository.findBySessionId(sessionId);
    const toolSessionRef = threadRef || existingSession?.toolSessionRef || "";

    this.deps.toolSessionRepository.upsert({
      sessionId,
      toolProvider: "codex",
      toolSessionRef,
      status: risk.level === "high" ? "waiting_confirm" : "running",
      createdBy: parsed.senderId,
      createdAt: now,
      updatedAt: now
    });
    this.upsertSessionRoute({
      sessionId,
      senderOpenId: parsed.senderId,
      chatType: message.chatType,
      chatId: message.chatId,
      platformMessageId: parsed.platformMessageId,
      now
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
    const replyTarget = this.resolveReplyTarget(message);
    const notify = await this.notifyTaskStatus({
      taskId,
      sessionId,
      status,
      summary: parsed.prompt,
      taskTitle: parsed.prompt,
      detail: parsed.prompt,
      actorId: parsed.senderId,
      recipientOpenId: replyTarget.recipientOpenId,
      recipientChatId: replyTarget.recipientChatId,
      threadRef
    });
    await this.deps.auditLogRepository.create({
      eventId: randomUUID(),
      taskId,
      sessionId,
      action: "feishu_notify_status",
      actorId: parsed.senderId,
      result: this.normalizeNotifyResult(notify),
      detail: `sent=${notify.sent}; skipped=${notify.skipped}; reason=${notify.reason || "null"}; statusCode=${notify.statusCode ?? "null"}; threadRef=${threadRef || "null"}; model=${selectedModelSlug || "null"}`,
      createdAt: now
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
            threadRef,
            modelSlug: selectedModelSlug,
            modelReasoningLevel: selectedReasoningLevel,
            projectPath: selectedProjectPath
          });

    this.deps.feishuCommandPanelService?.clearComposeMode(parsed.senderId);

    return {
      accepted: true,
      sessionId,
      taskId,
      riskLevel: risk.level,
      pendingConfirmation: risk.level === "high",
      message: risk.level === "high" ? "High risk command pending confirmation" : "Command accepted",
      threadRef,
      senderIdentity: senderIdentity
        ? {
            openId: senderIdentity.openId,
            displayName: senderIdentity.displayName,
            bindingSource: senderIdentity.bindingSource,
            boundBy: senderIdentity.boundBy
          }
        : null,
      notify,
      dispatch
    };
  }

  private resolveSessionId(input: {
    explicitSessionId: string | null;
    senderId: string;
    chatType: FeishuSessionRouteChatType | null;
    chatId: string | null;
    fallbackSessionPrefix: string;
  }) {
    const explicit = (input.explicitSessionId || "").trim();
    if (explicit) {
      return explicit;
    }

    const latestSessionByRoute = this.resolveLatestSessionByRoute({
      senderOpenId: input.senderId,
      chatType: input.chatType,
      chatId: input.chatId
    });
    if (latestSessionByRoute) {
      return latestSessionByRoute;
    }

    const latestSession = this.deps.messageRepository.findLatestSessionIdBySender(input.senderId, "feishu");
    if (latestSession) {
      return latestSession;
    }

    const fallback = (input.fallbackSessionPrefix || "").trim();
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

    const localResolved = this.deps.codexLocalSessionService?.resolveThreadSelector(selector);
    if (localResolved?.status === "resolved") {
      return localResolved.threadId;
    }
    if (localResolved?.status === "ambiguous") {
      throw new AppError(
        "THREAD_SELECTOR_AMBIGUOUS",
        409,
        `Thread selector matches multiple local sessions: ${localResolved.candidates.join(", ")}`
      );
    }

    const uuidMatched = selector.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
    if (uuidMatched) {
      return uuidMatched[0].toLowerCase();
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

  private resolveLatestSessionByRoute(input: {
    senderOpenId: string;
    chatType: FeishuSessionRouteChatType | null;
    chatId: string | null;
  }) {
    if (input.chatType === "group" && input.chatId) {
      return this.deps.feishuSessionRouteRepository.findLatestSessionIdBySenderAndChat({
        senderOpenId: input.senderOpenId,
        chatType: "group",
        chatId: input.chatId
      });
    }

    if (input.chatType === "p2p") {
      return this.deps.feishuSessionRouteRepository.findLatestSessionIdBySenderAndChat({
        senderOpenId: input.senderOpenId,
        chatType: "p2p",
        chatId: null
      });
    }

    return null;
  }

  private upsertSessionRoute(input: {
    sessionId: string;
    senderOpenId: string;
    chatType: FeishuSessionRouteChatType | null;
    chatId: string | null;
    platformMessageId: string | null;
    now: string;
  }) {
    if (!this.isOpenId(input.senderOpenId)) {
      return;
    }

    const isGroup = input.chatType === "group" && Boolean((input.chatId || "").trim());
    this.deps.feishuSessionRouteRepository.upsert({
      sessionId: input.sessionId,
      sourcePlatform: "feishu",
      chatType: isGroup ? "group" : "p2p",
      chatId: isGroup ? input.chatId!.trim() : null,
      senderOpenId: input.senderOpenId,
      lastPlatformMessageId: input.platformMessageId,
      routeStatus: "active",
      createdAt: input.now,
      updatedAt: input.now
    });
  }

  private validateIncomingRoute(message: FeishuIncomingMessage) {
    if (message.chatType !== "group") {
      return {
        accepted: true
      } as const;
    }

    if (message.mentioned || message.allowImplicitDispatch) {
      return {
        accepted: true
      } as const;
    }

    return {
      accepted: true,
      ignored: true,
      reason: "group_not_mentioned"
    } as const;
  }

  private resolveReplyTarget(message: {
    senderId: string;
    chatType: FeishuSessionRouteChatType | null;
    chatId: string | null;
  }) {
    const normalizedChatId = (message.chatId || "").trim();
    if (message.chatType === "group" && normalizedChatId) {
      return {
        recipientOpenId: null,
        recipientChatId: normalizedChatId
      };
    }

    if (message.chatType === "p2p" && normalizedChatId && !this.isOpenId(message.senderId)) {
      return {
        recipientOpenId: null,
        recipientChatId: normalizedChatId
      };
    }

    return {
      recipientOpenId: message.senderId,
      recipientChatId: null
    };
  }

  private dispatchTask(input: {
    taskId: string;
    sessionId: string;
    prompt: string;
    actorId: string;
    threadRef?: string | null;
    modelSlug?: string | null;
    modelReasoningLevel?: string | null;
    projectPath?: string | null;
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

    const result = this.deps.codexDispatchService.dispatchTask({
      taskId: input.taskId,
      sessionId: input.sessionId,
      prompt: input.prompt,
      actorId: input.actorId,
      threadRef: input.threadRef ?? null,
      modelSlug: input.modelSlug ?? null,
      modelReasoningLevel: input.modelReasoningLevel ?? null,
      projectPath: input.projectPath ?? null
    });
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
    recipientChatId?: string | null;
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

  private notifyCard(input: { card: string; recipientOpenId?: string | null; recipientChatId?: string | null }) {
    if (!this.deps.feishuNotifier) {
      return Promise.resolve({
        sent: false,
        skipped: true,
        reason: "notifier_disabled",
        statusCode: null
      });
    }

    return this.deps.feishuNotifier.notifyCard(input);
  }

  private notifyIdentityBinding(input: {
    senderId: string;
    chatId: string | null;
    chatType: FeishuSessionRouteChatType | null;
    displayName: string;
    openId: string;
  }) {
    if (!this.deps.feishuNotifier) {
      return Promise.resolve({
        sent: false,
        skipped: true,
        reason: "notifier_disabled",
        statusCode: null
      });
    }

    const replyTarget = this.resolveReplyTarget({
      senderId: input.senderId,
      chatId: input.chatId,
      chatType: input.chatType
    });
    return this.deps.feishuNotifier.notifyText({
      text: `已绑定姓名：${input.displayName} (${input.openId})`,
      recipientOpenId: replyTarget.recipientOpenId,
      recipientChatId: replyTarget.recipientChatId
    });
  }

  private notifyCommandGuidance(input: {
    senderId: string;
    chatId: string | null;
    chatType: FeishuSessionRouteChatType | null;
    reason: string;
  }) {
    if (!this.deps.feishuNotifier) {
      return Promise.resolve({
        sent: false,
        skipped: true,
        reason: "notifier_disabled",
        statusCode: null
      });
    }

    const normalizedReason = this.normalizeCommandGuidanceReason(input.reason);
    const replyTarget = this.resolveReplyTarget({
      senderId: input.senderId,
      chatId: input.chatId,
      chatType: input.chatType
    });
    return this.deps.feishuNotifier.notifyCard({
      card: buildFeishuCommandHelpCard(normalizedReason),
      recipientOpenId: replyTarget.recipientOpenId,
      recipientChatId: replyTarget.recipientChatId
    });
  }

  private normalizeNotifyResult(notify: { sent: boolean; skipped: boolean }) {
    if (notify.sent) {
      return "success";
    }

    if (notify.skipped) {
      return "skipped";
    }

    return "failed";
  }

  private isCommandGuidanceError(code: string) {
    return code === "EMPTY_COMMAND" || code === "SESSION_REQUIRED" || code === "THREAD_NOT_FOUND" || code === "THREAD_SELECTOR_AMBIGUOUS";
  }

  private normalizeCommandGuidanceReason(reason: string): "ambiguous_command" | "session_required" | "thread_not_found" | "thread_selector_ambiguous" {
    if (reason === "session_required") {
      return "session_required";
    }

    if (reason === "thread_not_found") {
      return "thread_not_found";
    }

    if (reason === "thread_selector_ambiguous") {
      return "thread_selector_ambiguous";
    }

    return "ambiguous_command";
  }

  private mapCommandGuidanceReason(code: string) {
    if (code === "SESSION_REQUIRED") {
      return "session_required";
    }

    if (code === "THREAD_NOT_FOUND") {
      return "thread_not_found";
    }

    if (code === "THREAD_SELECTOR_AMBIGUOUS") {
      return "thread_selector_ambiguous";
    }

    return "ambiguous_command";
  }

  private resolveLatestAssistantMessage(threadSelector: string) {
    const selector = (threadSelector || "").trim();
    if (!selector || !this.deps.codexLocalSessionService) {
      return null;
    }

    const resolved = this.deps.codexLocalSessionService.resolveThreadSelector(selector);
    if (resolved.status !== "resolved") {
      return null;
    }

    try {
      const detail = this.deps.codexLocalSessionService.getSessionDetail({
        threadId: resolved.threadId,
        refresh: true
      });
      const latestAssistant = [...detail.messages]
        .reverse()
        .find((message) => message.kind === "message" && message.role === "assistant" && (message.content || "").trim());
      return latestAssistant?.content?.trim() || null;
    } catch {
      return null;
    }
  }

  private isOpenId(value: string) {
    return /^ou_[a-zA-Z0-9_-]+$/.test((value || "").trim());
  }
}
