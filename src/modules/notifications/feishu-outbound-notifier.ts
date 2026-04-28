/**
 * @description 飞书消息回推器，支持机器人 webhook 与官方开放平台消息发送两种回推方式
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-26 18:20
 */
import { ConnectorConfigService } from "../connectors/connector-config-service";
import type { ConnectorConfigRecord } from "../../storage/repositories/connector-config-repository";
import { IdempotencyRepository } from "../../storage/repositories/idempotency-repository";
import { FeishuIdentityRepository } from "../../storage/repositories/feishu-identity-repository";
import { buildFeishuTaskStatusCard } from "../feishu/feishu-command-panel";
import {
  formatCodexTokenUsageBreakdown,
  type CodexRuntimeMeta,
  type CodexTokenUsageBreakdown
} from "../codex/codex-runtime-meta";

export type FeishuNotifyResult = {
  sent: boolean;
  skipped: boolean;
  reason: string | null;
  statusCode: number | null;
};

type NotifyTaskStatusInput = {
  taskId: string;
  sessionId: string;
  status: string;
  summary: string;
  taskTitle?: string | null;
  detail?: string | null;
  actorId: string;
  recipientOpenId?: string | null;
  threadAlias?: string | null;
  threadRef?: string | null;
  runtimeMeta?: CodexRuntimeMeta;
};

type NotifyTextInput = {
  text: string;
  recipientOpenId?: string | null;
};

type NotifyCardInput = {
  card: string;
  recipientOpenId?: string | null;
};

type FeishuOutboundNotifierOptions = {
  timeoutMs?: number;
  openBaseUrl?: string;
  fetchImpl?: typeof fetch;
  idempotencyRepository?: IdempotencyRepository;
  feishuIdentityRepository?: FeishuIdentityRepository;
};

export class FeishuOutboundNotifier {
  private readonly timeoutMs: number;
  private readonly openBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly idempotencyRepository: IdempotencyRepository | null;
  private readonly feishuIdentityRepository: FeishuIdentityRepository | null;
  private tenantTokenCache:
    | {
        token: string;
        expiredAtMs: number;
      }
    | null = null;

  constructor(private readonly connectorConfigService: ConnectorConfigService, options: FeishuOutboundNotifierOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 6000;
    this.openBaseUrl = (options.openBaseUrl ?? "https://open.feishu.cn").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.idempotencyRepository = options.idempotencyRepository ?? null;
    this.feishuIdentityRepository = options.feishuIdentityRepository ?? null;
  }

  async notifyTaskStatus(input: NotifyTaskStatusInput): Promise<FeishuNotifyResult> {
    const config = this.connectorConfigService.getConfig("feishu");

    if (!config.enabled) {
      return {
        sent: false,
        skipped: true,
        reason: "connector_disabled",
        statusCode: null
      };
    }

    const duplicateResult = this.skipDuplicateTaskStatusNotification(input);
    if (duplicateResult) {
      return duplicateResult;
    }

    const renderedText = this.buildTaskStatusText(config, input);
    const card = buildFeishuTaskStatusCard({
      title: this.resolveTaskTitle(input),
      statusLabel: this.resolveStatusLabel(input.status),
      summary: input.summary,
      detail: this.resolveDetail(input),
      taskId: input.taskId,
      sessionId: input.sessionId,
      actorId: input.actorId,
      actorLabel: this.resolveActorLabel(input.actorId),
      threadRef: (input.threadRef || "").trim(),
      threadAlias: (input.threadAlias || "").trim(),
      renderedText,
      footerNote: this.buildRuntimeNote(input.runtimeMeta ?? null)
    });
    return this.dispatchCard(config, card, input.recipientOpenId ?? null);
  }

  async notifyText(input: NotifyTextInput): Promise<FeishuNotifyResult> {
    const config = this.connectorConfigService.getConfig("feishu");

    if (!config.enabled) {
      return {
        sent: false,
        skipped: true,
        reason: "connector_disabled",
        statusCode: null
      };
    }

    return this.dispatchText(config, input.text, input.recipientOpenId ?? null);
  }

  async notifyCard(input: NotifyCardInput): Promise<FeishuNotifyResult> {
    const config = this.connectorConfigService.getConfig("feishu");

    if (!config.enabled) {
      return {
        sent: false,
        skipped: true,
        reason: "connector_disabled",
        statusCode: null
      };
    }

    return this.dispatchCard(config, input.card, input.recipientOpenId ?? null);
  }

  private async dispatchText(config: ConnectorConfigRecord, text: string, recipientOpenId: string | null) {
    const callbackUrl = (config.callbackUrl || "").trim();

    if (callbackUrl && this.isBotWebhook(callbackUrl) && !this.isLocalIngressPath(callbackUrl)) {
      return this.postWebhookText(callbackUrl, text);
    }

    return this.postOpenApiText(config, text, recipientOpenId);
  }

  private async dispatchCard(config: ConnectorConfigRecord, cardContent: string, recipientOpenId: string | null) {
    const callbackUrl = (config.callbackUrl || "").trim();

    if (callbackUrl && this.isBotWebhook(callbackUrl) && !this.isLocalIngressPath(callbackUrl)) {
      return this.postWebhookCard(callbackUrl, cardContent);
    }

    return this.postOpenApiCard(config, cardContent, recipientOpenId);
  }

  private skipDuplicateTaskStatusNotification(input: NotifyTaskStatusInput) {
    if (!this.idempotencyRepository) {
      return null;
    }

    const keyParts = [
      "feishu:task-status",
      input.taskId.trim(),
      input.status.trim(),
      (input.recipientOpenId || "").trim() || "broadcast"
    ];
    const idempotencyKey = keyParts.join(":");
    const isNew = this.idempotencyRepository.saveIfAbsent({
      idempotencyKey,
      scope: "feishu_notify_status",
      createdAt: new Date().toISOString()
    });

    if (isNew) {
      return null;
    }

    return {
      sent: false,
      skipped: true,
      reason: "duplicate_notification",
      statusCode: null
    } satisfies FeishuNotifyResult;
  }

  private isBotWebhook(url: string) {
    return /\/open-apis\/bot\/v2\/hook\//.test(url);
  }

  private isLocalIngressPath(url: string) {
    try {
      const parsed = new URL(url);
      return parsed.pathname === "/api/feishu/webhook";
    } catch {
      return false;
    }
  }

  private async postWebhookText(webhookUrl: string, text: string): Promise<FeishuNotifyResult> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      abortController.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          msg_type: "text",
          content: { text }
        }),
        signal: abortController.signal
      });

      return {
        sent: response.ok,
        skipped: false,
        reason: response.ok ? null : "http_failed",
        statusCode: response.status
      };
    } catch {
      return {
        sent: false,
        skipped: false,
        reason: "request_failed",
        statusCode: null
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async postWebhookCard(webhookUrl: string, cardContent: string): Promise<FeishuNotifyResult> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      abortController.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          msg_type: "interactive",
          card: JSON.parse(cardContent)
        }),
        signal: abortController.signal
      });

      return {
        sent: response.ok,
        skipped: false,
        reason: response.ok ? null : "http_failed",
        statusCode: response.status
      };
    } catch {
      return {
        sent: false,
        skipped: false,
        reason: "request_failed",
        statusCode: null
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async postOpenApiText(
    config: ConnectorConfigRecord,
    text: string,
    recipientOpenId: string | null
  ): Promise<FeishuNotifyResult> {
    const appId = config.appId.trim();
    const appSecret = config.appSecret.trim();

    if (!appId || !appSecret) {
      return {
        sent: false,
        skipped: true,
        reason: "app_credentials_missing",
        statusCode: null
      };
    }

    if (!recipientOpenId) {
      return {
        sent: false,
        skipped: true,
        reason: "recipient_missing",
        statusCode: null
      };
    }

    const tokenResult = await this.fetchTenantAccessToken(appId, appSecret);
    if (!tokenResult.ok || !tokenResult.token) {
      return {
        sent: false,
        skipped: false,
        reason: "auth_failed",
        statusCode: tokenResult.statusCode
      };
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      abortController.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.openBaseUrl}/open-apis/im/v1/messages?receive_id_type=open_id`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenResult.token}`
        },
        body: JSON.stringify({
          receive_id: recipientOpenId,
          msg_type: "text",
          content: JSON.stringify({
            text
          })
        }),
        signal: abortController.signal
      });

      const payload = (await response.json().catch(() => null)) as { code?: number } | null;
      const success = response.ok && payload?.code === 0;

      return {
        sent: success,
        skipped: false,
        reason: success ? null : "api_send_failed",
        statusCode: response.status
      };
    } catch {
      return {
        sent: false,
        skipped: false,
        reason: "request_failed",
        statusCode: null
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async postOpenApiCard(
    config: ConnectorConfigRecord,
    cardContent: string,
    recipientOpenId: string | null
  ): Promise<FeishuNotifyResult> {
    const appId = config.appId.trim();
    const appSecret = config.appSecret.trim();

    if (!appId || !appSecret) {
      return {
        sent: false,
        skipped: true,
        reason: "app_credentials_missing",
        statusCode: null
      };
    }

    if (!recipientOpenId) {
      return {
        sent: false,
        skipped: true,
        reason: "recipient_missing",
        statusCode: null
      };
    }

    const tokenResult = await this.fetchTenantAccessToken(appId, appSecret);
    if (!tokenResult.ok || !tokenResult.token) {
      return {
        sent: false,
        skipped: false,
        reason: "auth_failed",
        statusCode: tokenResult.statusCode
      };
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      abortController.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.openBaseUrl}/open-apis/im/v1/messages?receive_id_type=open_id`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenResult.token}`
        },
        body: JSON.stringify({
          receive_id: recipientOpenId,
          msg_type: "interactive",
          content: cardContent
        }),
        signal: abortController.signal
      });

      const payload = (await response.json().catch(() => null)) as { code?: number } | null;
      const success = response.ok && payload?.code === 0;

      return {
        sent: success,
        skipped: false,
        reason: success ? null : "api_send_failed",
        statusCode: response.status
      };
    } catch {
      return {
        sent: false,
        skipped: false,
        reason: "request_failed",
        statusCode: null
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchTenantAccessToken(appId: string, appSecret: string) {
    if (this.tenantTokenCache && this.tenantTokenCache.expiredAtMs > Date.now() + 30_000) {
      return {
        ok: true,
        token: this.tenantTokenCache.token,
        statusCode: 200
      };
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      abortController.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.openBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          app_id: appId,
          app_secret: appSecret
        }),
        signal: abortController.signal
      });

      const payload = (await response.json().catch(() => null)) as
        | {
            code?: number;
            expire?: number;
            tenant_access_token?: string;
          }
        | null;

      const success = response.ok && payload?.code === 0 && typeof payload.tenant_access_token === "string";
      if (!success) {
        return {
          ok: false,
          token: null,
          statusCode: response.status
        };
      }

      const expireSeconds = typeof payload.expire === "number" ? payload.expire : 7200;
      const token = payload.tenant_access_token!;
      this.tenantTokenCache = {
        token,
        expiredAtMs: Date.now() + expireSeconds * 1000
      };

      return {
        ok: true,
        token,
        statusCode: response.status
      };
    } catch {
      return {
        ok: false,
        token: null,
        statusCode: null
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildTaskStatusText(
    config: ReturnType<ConnectorConfigService["getConfig"]>,
    input: NotifyTaskStatusInput
  ) {
    const template = this.pickTemplate(config, input.status);
    const statusLabel = this.resolveStatusLabel(input.status);
    const taskTitle = this.resolveTaskTitle(input);
    const detail = this.resolveDetail(input);
    const rendered = this.renderTemplate(template, {
      taskId: input.taskId,
      sessionId: input.sessionId,
      status: input.status,
      statusLabel,
      summary: input.summary,
      taskTitle,
      detail,
      actorId: input.actorId,
      threadAlias: (input.threadAlias || "").trim(),
      threadRef: (input.threadRef || "").trim()
    });

    if (!template.trim()) {
      return this.buildStructuredText({
        statusLabel,
        taskTitle,
        detail,
        taskId: input.taskId,
        sessionId: input.sessionId,
        actorId: input.actorId,
        status: input.status,
        threadAlias: (input.threadAlias || "").trim(),
        threadRef: (input.threadRef || "").trim()
      });
    }

    const hasAnyPlaceholder = /\{[^}]+\}/.test(template);
    if (!hasAnyPlaceholder) {
      return `${rendered}\n\n${this.buildStructuredText({
        statusLabel,
        taskTitle,
        detail,
        taskId: input.taskId,
        sessionId: input.sessionId,
        actorId: input.actorId,
        status: input.status,
        threadAlias: (input.threadAlias || "").trim(),
        threadRef: (input.threadRef || "").trim()
      })}`;
    }

    return this.ensureThreadLine(rendered, input);
  }

  private pickTemplate(config: ReturnType<ConnectorConfigService["getConfig"]>, status: string) {
    if (status === "running") {
      return config.templateTaskStarted;
    }

    if (status === "pending_confirm") {
      return config.templateTaskPendingConfirm;
    }

    if (status === "succeeded") {
      return config.templateTaskSucceeded;
    }

    return config.templateTaskFailed;
  }

  private renderTemplate(
    template: string,
    replacements: Record<
      | "taskId"
      | "sessionId"
      | "status"
      | "statusLabel"
      | "summary"
      | "taskTitle"
      | "detail"
      | "actorId"
      | "threadAlias"
      | "threadRef",
      string
    >
  ) {
    let text = template;
    text = text.replaceAll("{taskId}", replacements.taskId);
    text = text.replaceAll("{sessionId}", replacements.sessionId);
    text = text.replaceAll("{status}", replacements.status);
    text = text.replaceAll("{statusLabel}", replacements.statusLabel);
    text = text.replaceAll("{summary}", replacements.summary);
    text = text.replaceAll("{taskTitle}", replacements.taskTitle);
    text = text.replaceAll("{detail}", replacements.detail);
    text = text.replaceAll("{actorId}", replacements.actorId);
    text = text.replaceAll("{threadAlias}", replacements.threadAlias);
    text = text.replaceAll("{threadRef}", replacements.threadRef);
    return text.trim();
  }

  private resolveStatusLabel(status: string) {
    if (status === "running") {
      return "进行中";
    }
    if (status === "succeeded") {
      return "成功";
    }
    if (status === "failed") {
      return "失败";
    }
    if (status === "pending_confirm") {
      return "待确认";
    }
    if (status === "stopped") {
      return "已停止";
    }
    if (status === "rejected") {
      return "已拒绝";
    }
    return status;
  }

  private resolveTaskTitle(input: NotifyTaskStatusInput) {
    const explicit = (input.taskTitle || "").trim();
    if (explicit) {
      return this.limitText(explicit, 120);
    }

    const summary = (input.summary || "").trim();
    if (!summary) {
      return "未命名任务";
    }

    return this.limitText(
      summary
        .replace(/^Codex任务完成[:：]\s*/i, "")
        .replace(/^任务完成[:：]\s*/i, "")
        .replace(/^任务开始[:：]\s*/i, "")
        .trim() || "未命名任务",
      120
    );
  }

  private resolveDetail(input: NotifyTaskStatusInput) {
    const explicit = (input.detail || "").replace(/\u0000/g, "").trim();
    if (explicit) {
      return explicit;
    }

    const summary = (input.summary || "").replace(/\u0000/g, "").trim();
    if (summary) {
      return summary;
    }

    return "无";
  }

  private buildRuntimeNote(
    runtimeMeta: CodexRuntimeMeta
  ) {
    const durationText = this.formatDuration(runtimeMeta?.durationMs ?? null);
    const tokenText = this.formatNumber(runtimeMeta?.tokenUsage ?? runtimeMeta?.tokenUsageDetail?.totalTokens ?? null);
    const modelText = (runtimeMeta?.modelSlug || "").trim() || "--";
    const summaryLine = `该次任务耗时：${durationText} · 消耗 tokens：${tokenText} · 使用模型：${modelText}`;
    const totalUsageLine = this.formatRuntimeTokenLine("累计明细", runtimeMeta?.tokenUsageDetail ?? null);
    const lastUsageLine = this.formatRuntimeTokenLine("最近一次", runtimeMeta?.lastTokenUsageDetail ?? null);
    const extraLines = [totalUsageLine, lastUsageLine].filter(Boolean);

    return extraLines.length > 0 ? `${summaryLine}\n${extraLines.join("\n")}` : summaryLine;
  }

  private buildStructuredText(input: {
    statusLabel: string;
    taskTitle: string;
    detail: string;
    taskId: string;
    sessionId: string;
    actorId: string;
    status: string;
    threadAlias: string;
    threadRef: string;
  }) {
    const detailLabel = input.status === "running" || input.status === "pending_confirm" ? "任务内容" : "完成内容";
    const lines = [
      `任务状态：${input.statusLabel}`,
      `任务标题：${input.taskTitle}`,
      `${detailLabel}：${input.detail}`,
      `任务ID：${input.taskId}`,
      `会话ID：${input.sessionId}`,
      `触发方：${input.actorId}`
    ];

    const threadSelector = this.buildThreadSelector(input.threadRef);
    if (threadSelector) {
      lines.push(`线程 ID：${threadSelector}`);
    }

    return lines.join("\n");
  }

  private formatDuration(durationMs: number | null) {
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
      return "--";
    }

    const totalSeconds = Math.max(Math.round(durationMs / 1000), 0);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}时${minutes}分${seconds}秒`;
    }
    if (minutes > 0) {
      return `${minutes}分${seconds}秒`;
    }
    return `${seconds}秒`;
  }

  private formatNumber(value: number | null | undefined) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return "--";
    }

    return new Intl.NumberFormat("zh-CN").format(Math.round(value));
  }

  private formatRuntimeTokenLine(
    label: string,
    usage: CodexTokenUsageBreakdown | null
  ) {
    const formatted = formatCodexTokenUsageBreakdown(usage, (value) => this.formatNumber(value));
    if (!formatted) {
      return null;
    }

    return `${label}：${formatted}`;
  }

  private ensureThreadLine(rendered: string, input: NotifyTaskStatusInput) {
    const text = (rendered || "").trim();
    const selector = this.buildThreadSelector((input.threadRef || "").trim());

    if (!selector) {
      return text;
    }

    if (text.includes("线程 ID：") || text.includes(selector)) {
      return text;
    }

    return `${text}\n线程 ID：${selector}`.trim();
  }

  private buildThreadSelector(threadRef: string) {
    const normalizedThreadRef = threadRef.trim();
    if (!normalizedThreadRef) {
      return "";
    }

    return normalizedThreadRef;
  }

  private limitText(value: string, maxLength: number) {
    const cleaned = value.replace(/\u0000/g, "").trim();
    if (cleaned.length <= maxLength) {
      return cleaned;
    }
    return `${cleaned.slice(0, maxLength - 3)}...`;
  }

  private resolveActorLabel(actorId: string) {
    const normalizedActorId = (actorId || "").trim();
    if (!normalizedActorId) {
      return "未知";
    }

    if (!this.isFeishuOpenId(normalizedActorId)) {
      return normalizedActorId;
    }

    const identity = this.feishuIdentityRepository?.findByOpenId(normalizedActorId);
    const displayName = identity?.displayName?.trim();
    if (displayName) {
      return displayName;
    }

    return normalizedActorId;
  }

  private isFeishuOpenId(value: string) {
    return /^ou_[a-zA-Z0-9_-]+$/.test(value);
  }
}
