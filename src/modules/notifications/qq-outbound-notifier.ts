import { ConnectorConfigService } from "../connectors/connector-config-service";

export type QqNotifyResult = {
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
  recipientUserId?: string | null;
  recipientGroupId?: string | null;
  messageId?: string | null;
  eventId?: string | null;
};

type NotifyTextInput = {
  text: string;
  recipientUserId?: string | null;
  recipientGroupId?: string | null;
};

export type QqInlineKeyboardButton = {
  id: string;
  label: string;
  data: string;
  style?: 0 | 1 | 2 | 3 | 4;
};

export type QqInlineKeyboardRow = QqInlineKeyboardButton[];

type NotifyMarkdownInput = {
  content: string;
  recipientUserId?: string | null;
  recipientGroupId?: string | null;
  messageId?: string | null;
  eventId?: string | null;
  keyboardRows?: QqInlineKeyboardRow[];
};

type QqOutboundNotifierOptions = {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export class QqOutboundNotifier {
  private static readonly DEFAULT_OPEN_API_BASE_URL = "https://api.sgroup.qq.com";
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private tokenCache:
    | {
        token: string;
        expiredAtMs: number;
      }
    | null = null;

  constructor(private readonly connectorConfigService: ConnectorConfigService, options: QqOutboundNotifierOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 6000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async notifyTaskStatus(input: NotifyTaskStatusInput): Promise<QqNotifyResult> {
    const config = this.connectorConfigService.getConfig("qq");
    if (!config.enabled) {
      return {
        sent: false,
        skipped: true,
        reason: "connector_disabled",
        statusCode: null
      };
    }

    const statusLabel = this.resolveStatusLabel(input.status);
    const title = this.resolveTaskTitle(input);
    const detail = (input.detail || input.summary || "").trim() || "无";
    const detailLabel = input.status === "running" || input.status === "pending_confirm" ? "任务内容" : "完成内容";
    const text = this.renderTemplate(config, input, statusLabel, title, detail, detailLabel);
    return this.notifyText({
      text,
      recipientUserId: input.recipientUserId ?? null,
      recipientGroupId: input.recipientGroupId ?? null,
      messageId: input.messageId ?? null,
      eventId: input.eventId ?? null
    });
  }

  async notifyText(input: NotifyTextInput & { messageId?: string | null; eventId?: string | null }): Promise<QqNotifyResult> {
    const message = (input.text || "").trim();
    if (!message) {
      return {
        sent: false,
        skipped: true,
        reason: "message_empty",
        statusCode: null
      };
    }

    const auth = await this.resolveAuthContext();
    if (!auth.ok) {
      return auth.result;
    }

    if (input.recipientGroupId) {
      return this.postOpenApiMessage({
        url: `${auth.baseUrl}/v2/groups/${encodeURIComponent(input.recipientGroupId)}/messages`,
        token: auth.token,
        payload: this.buildMessagePayload(message, input.messageId ?? null, input.eventId ?? null)
      });
    }

    if (!input.recipientUserId) {
      return {
        sent: false,
        skipped: true,
        reason: "recipient_missing",
        statusCode: null
      };
    }

    return this.postOpenApiMessage({
      url: `${auth.baseUrl}/v2/users/${encodeURIComponent(input.recipientUserId)}/messages`,
      token: auth.token,
      payload: this.buildMessagePayload(message, input.messageId ?? null, input.eventId ?? null)
    });
  }

  async notifyMarkdown(input: NotifyMarkdownInput): Promise<QqNotifyResult> {
    const content = (input.content || "").trim();
    if (!content) {
      return {
        sent: false,
        skipped: true,
        reason: "message_empty",
        statusCode: null
      };
    }

    const auth = await this.resolveAuthContext();
    if (!auth.ok) {
      return auth.result;
    }

    if (input.recipientGroupId) {
      return this.postOpenApiMessage({
        url: `${auth.baseUrl}/v2/groups/${encodeURIComponent(input.recipientGroupId)}/messages`,
        token: auth.token,
        payload: this.buildMarkdownMessagePayload({
          content,
          msgId: input.messageId ?? null,
          eventId: input.eventId ?? null,
          keyboardRows: input.keyboardRows ?? []
        })
      });
    }

    if (!input.recipientUserId) {
      return {
        sent: false,
        skipped: true,
        reason: "recipient_missing",
        statusCode: null
      };
    }

    return this.postOpenApiMessage({
      url: `${auth.baseUrl}/v2/users/${encodeURIComponent(input.recipientUserId)}/messages`,
      token: auth.token,
      payload: this.buildMarkdownMessagePayload({
        content,
        msgId: input.messageId ?? null,
        eventId: input.eventId ?? null,
        keyboardRows: input.keyboardRows ?? []
      })
    });
  }

  async acknowledgeInteraction(interactionId: string, data?: Record<string, unknown>) {
    const normalizedInteractionId = (interactionId || "").trim();
    if (!normalizedInteractionId) {
      return {
        sent: false,
        skipped: true,
        reason: "interaction_id_missing",
        statusCode: null
      } satisfies QqNotifyResult;
    }

    const auth = await this.resolveAuthContext();
    if (!auth.ok) {
      return auth.result;
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${auth.baseUrl}/interactions/${encodeURIComponent(normalizedInteractionId)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `QQBot ${auth.token}`
        },
        body: JSON.stringify({
          code: 0,
          ...(data ? { data } : {})
        }),
        signal: abortController.signal
      });
      const payload = (await response.json().catch(() => null)) as { code?: number } | null;
      const ok = response.ok && (payload?.code === undefined || payload.code === 0);
      return {
        sent: ok,
        skipped: false,
        reason: ok ? null : "api_send_failed",
        statusCode: response.status
      } satisfies QqNotifyResult;
    } catch {
      return {
        sent: false,
        skipped: false,
        reason: "request_failed",
        statusCode: null
      } satisfies QqNotifyResult;
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildMessagePayload(content: string, msgId: string | null, eventId: string | null) {
    return {
      content,
      msg_type: 0,
      ...(eventId ? { event_id: eventId } : {}),
      ...(msgId ? { msg_id: msgId } : {})
    };
  }

  private buildMarkdownMessagePayload(input: {
    content: string;
    msgId: string | null;
    eventId: string | null;
    keyboardRows: QqInlineKeyboardRow[];
  }) {
    const rows = input.keyboardRows
      .map((row) => row.filter((button) => (button.id || "").trim() && (button.label || "").trim() && (button.data || "").trim()))
      .filter((row) => row.length > 0)
      .map((row) => ({
        buttons: row.map((button) => ({
          id: button.id,
          render_data: {
            label: button.label,
            visited_label: button.label,
            style: button.style ?? 1
          },
          action: {
            type: 1,
            data: button.data
          }
        }))
      }));

    return {
      msg_type: 2,
      markdown: {
        content: input.content
      },
      ...(input.eventId ? { event_id: input.eventId } : {}),
      ...(input.msgId ? { msg_id: input.msgId } : {}),
      ...(rows.length > 0
        ? {
            keyboard: {
              content: {
                rows
              }
            }
          }
        : {})
    };
  }

  private async resolveAuthContext():
    Promise<
      | {
          ok: true;
          baseUrl: string;
          token: string;
        }
      | {
          ok: false;
          result: QqNotifyResult;
        }
    > {
    const config = this.connectorConfigService.getConfig("qq");
    if (!config.enabled) {
      return {
        ok: false,
        result: {
          sent: false,
          skipped: true,
          reason: "connector_disabled",
          statusCode: null
        }
      };
    }

    const appId = (config.appId || "").trim();
    const clientSecret = (config.appSecret || "").trim();
    if (!appId || !clientSecret) {
      return {
        ok: false,
        result: {
          sent: false,
          skipped: true,
          reason: "app_credentials_missing",
          statusCode: null
        }
      };
    }

    const tokenResult = await this.fetchAppAccessToken({
      appId,
      clientSecret
    });
    if (!tokenResult.ok || !tokenResult.token) {
      return {
        ok: false,
        result: {
          sent: false,
          skipped: false,
          reason: "auth_failed",
          statusCode: tokenResult.statusCode
        }
      };
    }

    return {
      ok: true,
      baseUrl: this.resolveOpenApiBaseUrl(config.callbackUrl),
      token: tokenResult.token
    };
  }

  private resolveOpenApiBaseUrl(rawValue: string) {
    const fallback = QqOutboundNotifier.DEFAULT_OPEN_API_BASE_URL;
    const value = (rawValue || "").trim();
    if (!value) {
      return fallback;
    }

    try {
      const parsed = new URL(value);
      const host = parsed.hostname.toLowerCase();
      const path = parsed.pathname.toLowerCase();
      const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
      const looksLikeGatewayWebhook = path.includes("/api/qq/webhook") || path.includes("/api/feishu/webhook");
      if (isLoopback || looksLikeGatewayWebhook) {
        return fallback;
      }
      return parsed.origin.replace(/\/+$/, "");
    } catch {
      return fallback;
    }
  }

  private async postOpenApiMessage(input: { url: string; token: string; payload: Record<string, unknown> }) {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(input.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `QQBot ${input.token}`
        },
        body: JSON.stringify(input.payload),
        signal: abortController.signal
      });
      const payload = (await response.json().catch(() => null)) as { id?: string; code?: number; message?: string } | null;
      const ok = response.ok && Boolean(payload?.id);
      return {
        sent: ok,
        skipped: false,
        reason: ok ? null : "api_send_failed",
        statusCode: response.status
      } satisfies QqNotifyResult;
    } catch {
      return {
        sent: false,
        skipped: false,
        reason: "request_failed",
        statusCode: null
      } satisfies QqNotifyResult;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchAppAccessToken(input: { appId: string; clientSecret: string }) {
    if (this.tokenCache && this.tokenCache.expiredAtMs > Date.now() + 30_000) {
      return {
        ok: true,
        token: this.tokenCache.token,
        statusCode: 200
      };
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl("https://bots.qq.com/app/getAppAccessToken", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          appId: input.appId,
          clientSecret: input.clientSecret
        }),
        signal: abortController.signal
      });
      const payload = (await response.json().catch(() => null)) as
        | { access_token?: string; expires_in?: number | string }
        | null;
      const token = (payload?.access_token || "").trim();
      const expiresInRaw = Number(payload?.expires_in ?? 0);
      const expiresIn = Number.isFinite(expiresInRaw) && expiresInRaw > 0 ? expiresInRaw : 7200;
      if (!response.ok || !token) {
        return {
          ok: false,
          token: null,
          statusCode: response.status
        };
      }

      this.tokenCache = {
        token,
        expiredAtMs: Date.now() + expiresIn * 1000
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

  private resolveStatusLabel(status: string) {
    if (status === "running") return "进行中";
    if (status === "succeeded") return "成功";
    if (status === "failed") return "失败";
    if (status === "pending_confirm") return "待确认";
    if (status === "stopped") return "已停止";
    if (status === "rejected") return "已拒绝";
    return status;
  }

  private resolveTaskTitle(input: NotifyTaskStatusInput) {
    const title = (input.taskTitle || "").trim();
    if (title) return title;
    const summary = (input.summary || "").trim();
    return summary || "未命名任务";
  }

  private renderTemplate(
    config: ReturnType<ConnectorConfigService["getConfig"]>,
    input: NotifyTaskStatusInput,
    statusLabel: string,
    taskTitle: string,
    detail: string,
    detailLabel: string
  ) {
    const rawTemplate =
      input.status === "running"
        ? config.templateTaskStarted
        : input.status === "pending_confirm"
          ? config.templateTaskPendingConfirm
          : input.status === "succeeded"
            ? config.templateTaskSucceeded
            : config.templateTaskFailed;

    const template = (rawTemplate || "").trim();
    if (!template) {
      return [
        `任务状态：${statusLabel}`,
        `任务标题：${taskTitle}`,
        `${detailLabel}：${detail}`,
        `任务ID：${input.taskId}`,
        `会话ID：${input.sessionId}`,
        `触发方：${input.actorId}`
      ].join("\n");
    }

    return template
      .replaceAll("{taskId}", input.taskId)
      .replaceAll("{sessionId}", input.sessionId)
      .replaceAll("{status}", input.status)
      .replaceAll("{statusLabel}", statusLabel)
      .replaceAll("{summary}", input.summary || "")
      .replaceAll("{taskTitle}", taskTitle)
      .replaceAll("{detail}", detail)
      .replaceAll("{actorId}", input.actorId);
  }
}
