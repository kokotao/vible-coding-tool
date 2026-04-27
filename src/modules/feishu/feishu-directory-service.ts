/**
 * @description 飞书目录服务，提供最近 open_id 查询与指定 open_id 消息发送
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-26 18:20
 */
import { randomUUID } from "node:crypto";
import { AppError } from "../../lib/errors";
import { FeishuIdentityService } from "./feishu-identity-service";
import { FeishuOutboundNotifier } from "../notifications/feishu-outbound-notifier";
import { MessageRepository } from "../../storage/repositories/message-repository";

type FeishuDirectoryServiceDeps = {
  messageRepository: MessageRepository;
  feishuNotifier: FeishuOutboundNotifier;
  feishuIdentityService: FeishuIdentityService;
};

export class FeishuDirectoryService {
  constructor(private readonly deps: FeishuDirectoryServiceDeps) {}

  getRecentOpenIds(limit = 20) {
    const normalizedLimit = Math.min(Math.max(limit, 1), 100);
    const items = this.deps.messageRepository.listRecentFeishuOpenIds(normalizedLimit);
    const bindings = this.deps.feishuIdentityService.listRecentBindings(normalizedLimit);
    const merged = new Map<
      string,
      {
        openId: string;
        sessionId: string;
        lastSeenAt: string;
        messageCount: number;
        displayName: string | null;
        displayLabel: string;
        bindingSource: "auto" | "manual" | null;
      }
    >();

    for (const item of items) {
      const identity = this.deps.feishuIdentityService.getCachedIdentity(item.openId);
      const displayName = identity?.displayName?.trim() || null;

      merged.set(item.openId, {
        openId: item.openId,
        sessionId: item.sessionId,
        lastSeenAt: item.lastSeenAt,
        messageCount: item.messageCount,
        displayName,
        displayLabel: displayName ? `${displayName} (${item.openId})` : item.openId,
        bindingSource: identity?.bindingSource ?? null
      });
    }

    for (const binding of bindings) {
      const existing = merged.get(binding.openId);
      if (existing) {
        existing.displayName = binding.displayName;
        existing.displayLabel = `${binding.displayName} (${binding.openId})`;
        existing.bindingSource = binding.bindingSource;
        if (binding.updatedAt > existing.lastSeenAt) {
          existing.lastSeenAt = binding.updatedAt;
        }
        continue;
      }

      merged.set(binding.openId, {
        openId: binding.openId,
        sessionId: `feishu-identity-${binding.openId}`,
        lastSeenAt: binding.updatedAt,
        messageCount: 0,
        displayName: binding.displayName,
        displayLabel: `${binding.displayName} (${binding.openId})`,
        bindingSource: binding.bindingSource
      });
    }

    return {
      items: [...merged.values()]
        .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
        .slice(0, normalizedLimit)
    };
  }

  async sendMessageToOpenId(input: {
    openId: string;
    text: string;
    actorId?: string;
  }) {
    const openId = input.openId.trim();
    const text = input.text.trim();
    const actorId = input.actorId?.trim() || "web_console";

    if (!this.isOpenId(openId)) {
      throw new AppError("FEISHU_OPEN_ID_INVALID", 400, "Feishu open_id format is invalid");
    }

    if (!text) {
      throw new AppError("FEISHU_TEXT_REQUIRED", 400, "Message text is required");
    }

    const notify = await this.deps.feishuNotifier.notifyText({
      text,
      recipientOpenId: openId
    });

    this.deps.messageRepository.create({
      eventId: randomUUID(),
      sessionId: `feishu-direct-${openId}`,
      direction: "tool_to_bot",
      sourcePlatform: "feishu",
      platformMessageId: null,
      senderId: actorId,
      content: text,
      messageType: "manual_notify",
      riskLevel: "low",
      status: notify.sent ? "sent" : "failed",
      taskId: null,
      createdAt: new Date().toISOString()
    });

    return {
      success: notify.sent,
      openId,
      notify
    };
  }

  private isOpenId(value: string) {
    return /^ou_[a-zA-Z0-9_-]+$/.test(value);
  }
}
