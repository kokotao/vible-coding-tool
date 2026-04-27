import type { SqliteDatabase } from "../sqlite";

export type MessageRecord = {
  eventId: string;
  sessionId: string;
  direction: string;
  sourcePlatform: string;
  platformMessageId: string | null;
  senderId: string;
  content: string;
  messageType: string;
  riskLevel: string;
  status: string;
  taskId: string | null;
  createdAt: string;
};

export type RecentFeishuOpenIdRecord = {
  openId: string;
  sessionId: string;
  lastSeenAt: string;
  messageCount: number;
};

export class MessageRepository {
  constructor(private readonly db: SqliteDatabase) {}

  create(record: MessageRecord) {
    const statement = this.db.prepare(`
      INSERT INTO messages (
        event_id, session_id, direction, source_platform, platform_message_id,
        sender_id, content, message_type, risk_level, status, task_id, created_at
      ) VALUES (
        @eventId, @sessionId, @direction, @sourcePlatform, @platformMessageId,
        @senderId, @content, @messageType, @riskLevel, @status, @taskId, @createdAt
      )
    `);

    statement.run(record);
    return this.findByEventId(record.eventId);
  }

  findByEventId(eventId: string) {
    const statement = this.db.prepare(`
      SELECT
        event_id AS eventId,
        session_id AS sessionId,
        direction,
        source_platform AS sourcePlatform,
        platform_message_id AS platformMessageId,
        sender_id AS senderId,
        content,
        message_type AS messageType,
        risk_level AS riskLevel,
        status,
        task_id AS taskId,
        created_at AS createdAt
      FROM messages
      WHERE event_id = ?
    `);

    return statement.get(eventId) as MessageRecord | undefined;
  }

  listByTaskId(taskId: string) {
    const statement = this.db.prepare(`
      SELECT
        event_id AS eventId,
        session_id AS sessionId,
        direction,
        source_platform AS sourcePlatform,
        platform_message_id AS platformMessageId,
        sender_id AS senderId,
        content,
        message_type AS messageType,
        risk_level AS riskLevel,
        status,
        task_id AS taskId,
        created_at AS createdAt
      FROM messages
      WHERE task_id = ?
      ORDER BY created_at ASC, id ASC
    `);

    return statement.all(taskId) as MessageRecord[];
  }

  listBySessionId(sessionId: string, limit: number) {
    const statement = this.db.prepare(`
      SELECT
        event_id AS eventId,
        session_id AS sessionId,
        direction,
        source_platform AS sourcePlatform,
        platform_message_id AS platformMessageId,
        sender_id AS senderId,
        content,
        message_type AS messageType,
        risk_level AS riskLevel,
        status,
        task_id AS taskId,
        created_at AS createdAt
      FROM messages
      WHERE session_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `);

    return statement.all(sessionId, limit) as MessageRecord[];
  }

  findLatestBySessionId(sessionId: string) {
    const statement = this.db.prepare(`
      SELECT
        event_id AS eventId,
        session_id AS sessionId,
        direction,
        source_platform AS sourcePlatform,
        platform_message_id AS platformMessageId,
        sender_id AS senderId,
        content,
        message_type AS messageType,
        risk_level AS riskLevel,
        status,
        task_id AS taskId,
        created_at AS createdAt
      FROM messages
      WHERE session_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `);

    return statement.get(sessionId) as MessageRecord | undefined;
  }

  findLatestSessionIdBySender(senderId: string, sourcePlatform = "feishu") {
    const statement = this.db.prepare(`
      SELECT session_id AS sessionId
      FROM messages
      WHERE sender_id = ?
        AND source_platform = ?
        AND direction = 'bot_to_tool'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `);

    const row = statement.get(senderId, sourcePlatform) as { sessionId: string } | undefined;
    return row?.sessionId ?? null;
  }

  listRecentFeishuOpenIds(limit: number) {
    const statement = this.db.prepare(`
      WITH latest_sender AS (
        SELECT
          sender_id AS senderId,
          MAX(id) AS latestMessageId,
          COUNT(*) AS messageCount
        FROM messages
        WHERE source_platform = 'feishu'
          AND direction = 'bot_to_tool'
          AND sender_id LIKE 'ou_%'
        GROUP BY sender_id
        ORDER BY latestMessageId DESC
        LIMIT ?
      )
      SELECT
        m.sender_id AS openId,
        m.session_id AS sessionId,
        m.created_at AS lastSeenAt,
        latest_sender.messageCount AS messageCount
      FROM latest_sender
      JOIN messages m
        ON m.id = latest_sender.latestMessageId
      ORDER BY m.id DESC
    `);

    return statement.all(limit) as RecentFeishuOpenIdRecord[];
  }
}
