import { randomUUID } from "node:crypto";
import { AppError } from "../../lib/errors";
import { evaluateRisk } from "../risk/risk-guard";
import { ConnectorConfigService } from "../connectors/connector-config-service";
import { CodexDispatchService } from "../codex/codex-dispatch-service";
import { CodexLocalSessionService } from "../codex/codex-local-session-service";
import { QqOutboundNotifier, type QqInlineKeyboardRow } from "../notifications/qq-outbound-notifier";
import { IdempotencyRepository } from "../../storage/repositories/idempotency-repository";
import { MessageRepository } from "../../storage/repositories/message-repository";
import { RiskConfirmationRepository } from "../../storage/repositories/risk-confirmation-repository";
import { SessionThreadRepository } from "../../storage/repositories/session-thread-repository";
import {
  FeishuSessionRouteRepository,
  type FeishuSessionRouteChatType
} from "../../storage/repositories/feishu-session-route-repository";
import { TaskRepository } from "../../storage/repositories/task-repository";
import { ToolSessionRepository } from "../../storage/repositories/tool-session-repository";
import { AuditLogRepository } from "../../storage/repositories/audit-log-repository";
import { isExplicitQqCommand, parseQqCommand, type ParsedQqCommand } from "./qq-message-parser";

type QqWebhookServiceDeps = {
  taskRepository: TaskRepository;
  messageRepository: MessageRepository;
  riskConfirmationRepository: RiskConfirmationRepository;
  toolSessionRepository: ToolSessionRepository;
  sessionThreadRepository: SessionThreadRepository;
  auditLogRepository: AuditLogRepository;
  connectorConfigService: ConnectorConfigService;
  idempotencyRepository: IdempotencyRepository;
  feishuSessionRouteRepository: FeishuSessionRouteRepository;
  codexDispatchService?: CodexDispatchService;
  codexLocalSessionService?: CodexLocalSessionService;
  qqNotifier?: QqOutboundNotifier;
};

export type QqIncomingMessage = {
  senderId: string;
  messageId: string | null;
  eventId: string | null;
  text: string;
  chatId: string | null;
  chatType: FeishuSessionRouteChatType | null;
  mentioned: boolean;
  rawMessageId?: string | null;
  rawEventId?: string | null;
};

export type QqIncomingInteraction = {
  senderId: string;
  interactionId: string | null;
  eventId: string | null;
  messageId: string | null;
  buttonData: string;
  buttonId?: string | null;
  chatId: string | null;
  chatType: FeishuSessionRouteChatType | null;
};

type QqInteractionAction =
  | {
      actionType: "dispatch";
      text: string;
      source: "raw" | "json" | "structured";
    }
  | {
      actionType: "help";
      reason: "empty_button_data" | "shortcut_command" | "invalid_payload";
      hint?: string | null;
    };

const QQ_INTERACTION_SHORTCUT_TEXT = new Set([
  "help",
  "帮助",
  "指令帮助",
  "查看项目",
  "选择项目",
  "查看session",
  "查看会话",
  "新建session",
  "新建会话",
  "查看模型列表",
  "查看网关状态",
  "当前选择"
]);

const QQ_INTERACTION_HELP_KEYBOARD: QqInlineKeyboardRow[] = [
  [
    {
      id: "qq-help-session",
      label: "会话指令模板",
      data: JSON.stringify({
        action: "session_template"
      }),
      style: 1
    },
    {
      id: "qq-help-thread",
      label: "线程指令模板",
      data: JSON.stringify({
        action: "thread_template"
      }),
      style: 1
    }
  ],
  [
    {
      id: "qq-help-example",
      label: "示例任务模板",
      data: JSON.stringify({
        action: "example_task"
      }),
      style: 2
    },
    {
      id: "qq-help-doc",
      label: "指令帮助",
      data: JSON.stringify({
        action: "help"
      }),
      style: 1
    }
  ]
];

export class QqWebhookService {
  constructor(private readonly deps: QqWebhookServiceDeps) {}

  async handleIncomingMessage(message: QqIncomingMessage) {
    const routeCheck = this.validateIncomingRoute(message);
    if (routeCheck.ignored) {
      return routeCheck;
    }

    const shortcut = this.resolveTextShortcut(message.text);
    if (shortcut) {
      const notify = await this.notifyShortcutGuide({
        senderId: message.senderId,
        chatId: message.chatId,
        chatType: message.chatType,
        messageId: message.rawMessageId ?? message.messageId ?? null,
        eventId: message.rawEventId ?? message.eventId ?? null,
        hint: this.resolveShortcutHint(shortcut)
      });
      return {
        accepted: true,
        shortcutHandled: true,
        shortcut,
        notify
      };
    }

    let parsed: ParsedQqCommand;
    try {
      parsed = parseQqCommand({
        text: message.text,
        senderId: message.senderId,
        messageId: message.messageId
      });
    } catch (error) {
      if (error instanceof AppError && error.code === "EMPTY_COMMAND") {
        return {
          accepted: true,
          ignored: true,
          reason: "empty_command"
        };
      }
      throw error;
    }

    if (!parsed.prompt.trim()) {
      return this.buildRejected("ambiguous_command");
    }

    const connectorConfig = this.deps.connectorConfigService.getConfig("qq");
    let sessionId: string;
    let threadRef: string | null;
    try {
      sessionId = this.resolveSessionId({
        explicitSessionId: parsed.sessionId,
        senderId: parsed.senderId,
        chatType: message.chatType,
        chatId: message.chatId,
        fallbackSessionPrefix: connectorConfig.sessionPrefix
      });
      threadRef = this.resolveThreadRef(sessionId, parsed.threadSelector);
    } catch (error) {
      if (error instanceof AppError) {
        return this.buildRejected("session_or_thread_error", error.message);
      }
      throw error;
    }

    const now = new Date().toISOString();
    const idempotencyKey = `qq:webhook:${message.messageId || message.eventId || parsed.senderId}:${sessionId}`;
    const isNewEvent = this.deps.idempotencyRepository.saveIfAbsent({
      idempotencyKey,
      scope: "qq_webhook",
      createdAt: now
    });
    if (!isNewEvent) {
      return {
        accepted: true,
        duplicate: true,
        sessionId,
        message: "Duplicate event ignored"
      };
    }

    const risk = evaluateRisk(parsed.prompt, connectorConfig.riskKeywords);
    const taskId = randomUUID();
    const eventId = randomUUID();
    const existingSession = this.deps.toolSessionRepository.findBySessionId(sessionId);
    const toolSessionRef = threadRef || existingSession?.toolSessionRef || "";
    const taskStatus = risk.level === "high" ? "pending_confirm" : "running";

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
      senderId: parsed.senderId,
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
      status: taskStatus,
      summary: parsed.prompt,
      startedAt: now,
      finishedAt: null
    });

    this.deps.messageRepository.create({
      eventId,
      sessionId,
      direction: "bot_to_tool",
      sourcePlatform: "qq",
      platformMessageId: parsed.platformMessageId,
      senderId: parsed.senderId,
      content: parsed.prompt,
      messageType: "command",
      riskLevel: risk.level,
      status: taskStatus,
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

    const notify = await this.notifyTaskStatus({
      taskId,
      sessionId,
      status: taskStatus,
      summary: parsed.prompt,
      taskTitle: parsed.prompt,
      detail: parsed.prompt,
      actorId: parsed.senderId,
      ...this.resolveReplyTarget(message),
      threadRef,
      messageId: message.rawMessageId ?? message.messageId ?? null,
      eventId: message.rawEventId ?? message.eventId ?? null
    });
    this.deps.auditLogRepository.create({
      eventId: randomUUID(),
      taskId,
      sessionId,
      action: "qq_notify_status",
      actorId: parsed.senderId,
      result: notify.sent ? "success" : notify.skipped ? "skipped" : "failed",
      detail: `sent=${notify.sent}; skipped=${notify.skipped}; reason=${notify.reason || "null"}; statusCode=${notify.statusCode ?? "null"}; threadRef=${threadRef || "null"}`,
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

  async handleInteraction(interaction: QqIncomingInteraction) {
    const action = this.resolveInteractionAction(interaction.buttonData);
    if (action.actionType === "help") {
      const notify = await this.notifyInteractionHelp(interaction, action.hint || null);
      const acknowledge = await this.acknowledgeInteraction(interaction.interactionId);
      return {
        accepted: true,
        interactionHandled: true,
        reason: action.reason,
        notify,
        acknowledge
      };
    }

    const incomingResult = await this.handleIncomingMessage({
      senderId: interaction.senderId,
      messageId: null,
      eventId: interaction.interactionId || interaction.eventId || null,
      text: action.text,
      chatId: interaction.chatId,
      chatType: interaction.chatType,
      mentioned: true,
      rawMessageId: interaction.messageId,
      rawEventId: interaction.eventId
    });
    const acknowledge = await this.acknowledgeInteraction(interaction.interactionId);

    return {
      accepted: true,
      interactionHandled: true,
      command: action.text,
      source: action.source,
      result: incomingResult,
      acknowledge
    };
  }

  private buildRejected(reason: string, message = "指令不明确，请使用 #session:<id> <任务> 或 线程 ID：<id>，任务内容：<任务>") {
    return {
      accepted: false,
      skipped: true,
      reason,
      message
    };
  }

  private validateIncomingRoute(message: QqIncomingMessage) {
    const explicit = isExplicitQqCommand(message.text);
    if (message.chatType !== "group") {
      return { accepted: true } as const;
    }

    if (message.mentioned || explicit) {
      return { accepted: true } as const;
    }

    return {
      accepted: true,
      ignored: true,
      reason: "group_not_mentioned"
    } as const;
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
      senderId: input.senderId,
      chatType: input.chatType,
      chatId: input.chatId
    });
    if (latestSessionByRoute) {
      return latestSessionByRoute;
    }

    const latestSession = this.deps.messageRepository.findLatestSessionIdBySender(input.senderId, "qq");
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
    senderId: string;
    chatType: FeishuSessionRouteChatType | null;
    chatId: string | null;
  }) {
    if (input.chatType === "group" && input.chatId) {
      return this.deps.feishuSessionRouteRepository.findLatestSessionIdBySenderAndChatForPlatform({
        sourcePlatform: "qq",
        senderOpenId: input.senderId,
        chatType: "group",
        chatId: input.chatId
      });
    }

    if (input.chatType === "p2p") {
      return this.deps.feishuSessionRouteRepository.findLatestSessionIdBySenderAndChatForPlatform({
        sourcePlatform: "qq",
        senderOpenId: input.senderId,
        chatType: "p2p",
        chatId: null
      });
    }

    return null;
  }

  private upsertSessionRoute(input: {
    sessionId: string;
    senderId: string;
    chatType: FeishuSessionRouteChatType | null;
    chatId: string | null;
    platformMessageId: string | null;
    now: string;
  }) {
    const senderId = (input.senderId || "").trim();
    if (!senderId) {
      return;
    }

    const isGroup = input.chatType === "group" && Boolean((input.chatId || "").trim());
    this.deps.feishuSessionRouteRepository.upsert({
      sessionId: input.sessionId,
      sourcePlatform: "qq",
      chatType: isGroup ? "group" : "p2p",
      chatId: isGroup ? input.chatId!.trim() : null,
      senderOpenId: senderId,
      lastPlatformMessageId: input.platformMessageId,
      routeStatus: "active",
      createdAt: input.now,
      updatedAt: input.now
    });
  }

  private resolveReplyTarget(message: {
    senderId: string;
    chatType: FeishuSessionRouteChatType | null;
    chatId: string | null;
  }) {
    if (message.chatType === "group" && (message.chatId || "").trim()) {
      return {
        recipientUserId: null,
        recipientGroupId: message.chatId!.trim()
      };
    }

    return {
      recipientUserId: message.senderId,
      recipientGroupId: null
    };
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

    const result = this.deps.codexDispatchService.dispatchTask({
      taskId: input.taskId,
      sessionId: input.sessionId,
      prompt: input.prompt,
      actorId: input.actorId,
      threadRef: input.threadRef ?? null
    });
    return {
      accepted: result.accepted,
      skipped: result.skipped,
      reason: result.reason,
      pid: result.pid,
      threadRef: result.threadRef
    };
  }

  private resolveInteractionAction(buttonData: string): QqInteractionAction {
    const normalized = (buttonData || "").trim();
    if (!normalized) {
      return {
        actionType: "help",
        reason: "empty_button_data"
      };
    }

    const parsedRecord = this.tryParseInteractionPayload(normalized);
    if (parsedRecord) {
      const structured = this.resolveStructuredInteractionAction(parsedRecord);
      if (structured) {
        return structured;
      }
    }

    if (QQ_INTERACTION_SHORTCUT_TEXT.has(normalized.toLowerCase()) || QQ_INTERACTION_SHORTCUT_TEXT.has(normalized)) {
      return {
        actionType: "help",
        reason: "shortcut_command",
        hint: this.resolveShortcutHint(normalized)
      };
    }

    return {
      actionType: "dispatch",
      text: normalized,
      source: "raw"
    };
  }

  private tryParseInteractionPayload(raw: string) {
    if (!(raw.startsWith("{") && raw.endsWith("}"))) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  private resolveStructuredInteractionAction(record: Record<string, unknown>): QqInteractionAction | null {
    const action = String(record.action || record.panelAction || record.actionType || record.type || "")
      .trim()
      .toLowerCase();
    if (!action) {
      const command = this.buildInteractionCommand(record);
      if (!command) {
        return null;
      }
      return {
        actionType: "dispatch",
        text: command,
        source: "json"
      };
    }

    if (action === "help") {
      return {
        actionType: "help",
        reason: "shortcut_command"
      };
    }

    if (action === "session_template") {
      return {
        actionType: "help",
        reason: "shortcut_command",
        hint: "会话模板：#session:<会话ID> <任务内容>"
      };
    }

    if (action === "thread_template") {
      return {
        actionType: "help",
        reason: "shortcut_command",
        hint: "线程模板：线程 ID：<线程ID>，任务内容：<任务内容>"
      };
    }

    if (action === "example_task") {
      return {
        actionType: "help",
        reason: "shortcut_command",
        hint: "示例：#session:qq-codex 修复登录接口 500 并补单测"
      };
    }

    const command = this.buildInteractionCommand(record);
    if (!command) {
      return {
        actionType: "help",
        reason: "invalid_payload",
        hint: "按钮缺少可执行命令，请检查 button_data。"
      };
    }

    return {
      actionType: "dispatch",
      text: command,
      source: "structured"
    };
  }

  private buildInteractionCommand(record: Record<string, unknown>) {
    const explicitCommand = String(record.command || record.text || record.content || "").trim();
    if (explicitCommand) {
      return explicitCommand;
    }

    const prompt = String(record.prompt || record.task || "").trim();
    const sessionId = String(record.sessionId || record.session || "").trim();
    if (prompt && sessionId) {
      return `#session:${sessionId} ${prompt}`;
    }

    const threadId = String(record.threadId || record.threadRef || record.thread || "").trim();
    if (prompt && threadId) {
      return `线程 ID：${threadId}，任务内容：${prompt}`;
    }

    if (prompt) {
      return prompt;
    }

    return null;
  }

  private resolveShortcutHint(shortcut: string) {
    const normalized = shortcut.trim().toLowerCase();
    if (normalized === "查看项目") {
      return "QQ 端项目/会话面板会逐步补齐，当前先使用会话模板直接下发任务。";
    }
    if (normalized === "选择项目") {
      return "请选择具体项目名或路径，例如：选择项目：vible-coding-tool 或 选择项目路径：D:\\WorkSpace\\AlbertLuo";
    }
    if (normalized === "查看session" || normalized === "查看会话") {
      return "先选择一个会话 ID，再用 #session:<id> <任务内容> 下发。";
    }
    if (normalized === "新建session" || normalized === "新建会话") {
      return "QQ 端可直接指定新会话：#session:<新ID> <任务内容>。";
    }
    if (normalized === "查看模型列表") {
      return "模型快捷面板将在 QQ 端补齐，当前可直接在任务里描述模型需求。";
    }
    if (normalized === "查看网关状态") {
      return "请在网页控制台查看网关状态，或继续发送任务命令。";
    }
    if (normalized === "当前选择") {
      return "QQ 端上下文选择面板正在补齐，当前通过 #session / 线程 ID 显式指定。";
    }
    return "使用 #session 或 线程 ID 格式下发任务，可稳定进入现有执行链路。";
  }

  private resolveTextShortcut(text: string) {
    const normalized = (text || "").trim();
    if (!normalized) {
      return null;
    }
    if (QQ_INTERACTION_SHORTCUT_TEXT.has(normalized)) {
      return normalized;
    }
    if (QQ_INTERACTION_SHORTCUT_TEXT.has(normalized.toLowerCase())) {
      return normalized.toLowerCase();
    }
    return null;
  }

  private async notifyShortcutGuide(input: {
    senderId: string;
    chatId: string | null;
    chatType: FeishuSessionRouteChatType | null;
    messageId: string | null;
    eventId: string | null;
    hint: string;
  }) {
    return this.notifyMarkdownGuide({
      senderId: input.senderId,
      chatId: input.chatId,
      chatType: input.chatType,
      messageId: input.messageId,
      eventId: input.eventId,
      hint: input.hint
    });
  }

  private async notifyInteractionHelp(interaction: QqIncomingInteraction, hint: string | null) {
    return this.notifyMarkdownGuide({
      senderId: interaction.senderId,
      chatId: interaction.chatId,
      chatType: interaction.chatType,
      messageId: interaction.messageId,
      eventId: interaction.eventId,
      hint: hint || undefined
    });
  }

  private async notifyMarkdownGuide(input: {
    senderId: string;
    chatId: string | null;
    chatType: FeishuSessionRouteChatType | null;
    messageId: string | null;
    eventId: string | null;
    hint?: string | null;
  }) {
    if (!this.deps.qqNotifier) {
      return {
        sent: false,
        skipped: true,
        reason: "notifier_disabled",
        statusCode: null
      };
    }

    const helpContent = [
      "### QQ 交互指令说明",
      "",
      "支持直接进入任务流的两种格式：",
      "1. `#session:<会话ID> <任务内容>`",
      "2. `线程 ID：<线程ID>，任务内容：<任务内容>`",
      "",
      "和飞书保持一致的快捷词（查看项目/查看session/新建session/查看模型列表/查看网关状态/当前选择）已识别，QQ 面板能力会逐步补齐。",
      input.hint ? `补充说明：${input.hint}` : "补充说明：建议先使用上面两种模板可立即执行。"
    ].join("\n");

    return this.deps.qqNotifier.notifyMarkdown({
      content: helpContent,
      recipientUserId: input.chatType === "group" ? null : input.senderId,
      recipientGroupId: input.chatType === "group" ? input.chatId : null,
      messageId: input.messageId,
      eventId: input.eventId,
      keyboardRows: QQ_INTERACTION_HELP_KEYBOARD
    });
  }

  private async acknowledgeInteraction(interactionId: string | null) {
    if (!this.deps.qqNotifier) {
      return {
        sent: false,
        skipped: true,
        reason: "notifier_disabled",
        statusCode: null
      };
    }

    const normalizedInteractionId = (interactionId || "").trim();
    if (!normalizedInteractionId) {
      return {
        sent: false,
        skipped: true,
        reason: "interaction_id_missing",
        statusCode: null
      };
    }

    return this.deps.qqNotifier.acknowledgeInteraction(normalizedInteractionId);
  }

  private async notifyTaskStatus(input: {
    taskId: string;
    sessionId: string;
    status: string;
    summary: string;
    taskTitle?: string | null;
    detail?: string | null;
    actorId: string;
    recipientUserId?: string | null;
    recipientGroupId?: string | null;
    threadRef?: string | null;
    messageId?: string | null;
    eventId?: string | null;
  }) {
    if (!this.deps.qqNotifier) {
      return {
        sent: false,
        skipped: true,
        reason: "notifier_disabled",
        statusCode: null
      };
    }

    const detailWithThread =
      input.threadRef && !input.summary.includes("线程 ID：")
        ? `${input.detail || input.summary}\n线程 ID：${input.threadRef}`
        : input.detail || input.summary;

    return this.deps.qqNotifier.notifyTaskStatus({
      taskId: input.taskId,
      sessionId: input.sessionId,
      status: input.status,
      summary: input.summary,
      taskTitle: input.taskTitle,
      detail: detailWithThread,
      actorId: input.actorId,
      recipientUserId: input.recipientUserId ?? null,
      recipientGroupId: input.recipientGroupId ?? null,
      messageId: input.messageId ?? null,
      eventId: input.eventId ?? null
    });
  }
}
