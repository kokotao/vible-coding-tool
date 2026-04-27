/**
 * @description 飞书目录服务，提供最近 open_id 查询与指定 open_id 消息发送
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-26 18:20
 */
import { randomUUID } from "node:crypto";
import { AppError } from "../../lib/errors";
import { FeishuOutboundNotifier } from "../notifications/feishu-outbound-notifier";
import { MessageRepository } from "../../storage/repositories/message-repository";

type FeishuDirectoryServiceDeps = {
  messageRepository: MessageRepository;
  feishuNotifier: FeishuOutboundNotifier;
};

export class FeishuDirectoryService {
  constructor(private readonly deps: FeishuDirectoryServiceDeps) {}

  getRecentOpenIds(limit = 20) {
    const normalizedLimit = Math.min(Math.max(limit, 1), 100);
    const items = this.deps.messageRepository.listRecentFeishuOpenIds(normalizedLimit);

    return {
      items
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
