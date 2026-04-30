/**
 * @description 飞书会话路由仓储，维护 session 与群聊/私聊发送目标的稳定映射
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-28 18:28
 */
import type { SqliteDatabase } from "../sqlite";

export type FeishuSessionRouteChatType = "p2p" | "group";
export type FeishuSessionRouteStatus = "active" | "invalid";
export type SessionRoutePlatform = "feishu" | "qq";

export type FeishuSessionRouteRecord = {
  sessionId: string;
  sourcePlatform: SessionRoutePlatform;
  chatType: FeishuSessionRouteChatType;
  chatId: string | null;
  senderOpenId: string;
  lastPlatformMessageId: string | null;
  routeStatus: FeishuSessionRouteStatus;
  createdAt: string;
  updatedAt: string;
};

type FeishuSessionRouteRow = FeishuSessionRouteRecord;

export class FeishuSessionRouteRepository {
  constructor(private readonly db: SqliteDatabase) {}

  upsert(record: FeishuSessionRouteRecord) {
    const statement = this.db.prepare(`
      INSERT INTO feishu_session_routes (
        session_id, source_platform, chat_type, chat_id, sender_open_id,
        last_platform_message_id, route_status, created_at, updated_at
      ) VALUES (
        @sessionId, @sourcePlatform, @chatType, @chatId, @senderOpenId,
        @lastPlatformMessageId, @routeStatus, @createdAt, @updatedAt
      )
      ON CONFLICT(session_id) DO UPDATE SET
        source_platform = excluded.source_platform,
        chat_type = excluded.chat_type,
        chat_id = excluded.chat_id,
        sender_open_id = excluded.sender_open_id,
        last_platform_message_id = excluded.last_platform_message_id,
        route_status = excluded.route_status,
        updated_at = excluded.updated_at
    `);

    statement.run(record);
    return this.findBySessionId(record.sessionId);
  }

  findBySessionId(sessionId: string) {
    const statement = this.db.prepare(`
      SELECT
        session_id AS sessionId,
        source_platform AS sourcePlatform,
        chat_type AS chatType,
        chat_id AS chatId,
        sender_open_id AS senderOpenId,
        last_platform_message_id AS lastPlatformMessageId,
        route_status AS routeStatus,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM feishu_session_routes
      WHERE session_id = ?
      LIMIT 1
    `);

    return statement.get(sessionId) as FeishuSessionRouteRow | undefined;
  }

  findLatestSessionIdBySenderAndChat(input: { senderOpenId: string; chatType: FeishuSessionRouteChatType; chatId?: string | null }) {
    return this.findLatestSessionIdBySenderAndChatForPlatform({
      sourcePlatform: "feishu",
      senderOpenId: input.senderOpenId,
      chatType: input.chatType,
      chatId: input.chatId
    });
  }

  findLatestSessionIdBySenderAndChatForPlatform(input: {
    sourcePlatform: SessionRoutePlatform;
    senderOpenId: string;
    chatType: FeishuSessionRouteChatType;
    chatId?: string | null;
  }) {
    if (input.chatType === "group") {
      const statement = this.db.prepare(`
        SELECT session_id AS sessionId
        FROM feishu_session_routes
        WHERE source_platform = ?
          AND route_status = 'active'
          AND sender_open_id = ?
          AND chat_type = 'group'
          AND chat_id = ?
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      `);

      const row = statement.get(
        input.sourcePlatform,
        input.senderOpenId.trim(),
        (input.chatId || "").trim()
      ) as { sessionId: string } | undefined;
      return row?.sessionId ?? null;
    }

    const statement = this.db.prepare(`
      SELECT session_id AS sessionId
      FROM feishu_session_routes
      WHERE source_platform = ?
        AND route_status = 'active'
        AND sender_open_id = ?
        AND chat_type = 'p2p'
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `);
    const row = statement.get(input.sourcePlatform, input.senderOpenId.trim()) as { sessionId: string } | undefined;
    return row?.sessionId ?? null;
  }

  invalidateBySessionId(sessionId: string, updatedAt: string) {
    const statement = this.db.prepare(`
      UPDATE feishu_session_routes
      SET route_status = 'invalid',
          updated_at = @updatedAt
      WHERE session_id = @sessionId
    `);
    statement.run({
      sessionId: sessionId.trim(),
      updatedAt
    });
    return this.findBySessionId(sessionId);
  }
}
