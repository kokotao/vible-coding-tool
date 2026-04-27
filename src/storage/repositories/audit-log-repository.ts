import type { SqliteDatabase } from "../sqlite";

export type AuditLogRecord = {
  eventId: string;
  taskId: string | null;
  sessionId: string;
  action: string;
  actorId: string;
  result: string;
  detail: string | null;
  createdAt: string;
};

export class AuditLogRepository {
  constructor(private readonly db: SqliteDatabase) {}

  create(record: AuditLogRecord) {
    const statement = this.db.prepare(`
      INSERT INTO audit_logs (
        event_id, task_id, session_id, action, actor_id, result, detail, created_at
      ) VALUES (
        @eventId, @taskId, @sessionId, @action, @actorId, @result, @detail, @createdAt
      )
    `);

    statement.run(record);
    return this.findLatest(record.eventId);
  }

  findLatest(eventId: string) {
    const statement = this.db.prepare(`
      SELECT
        event_id AS eventId,
        task_id AS taskId,
        session_id AS sessionId,
        action,
        actor_id AS actorId,
        result,
        detail,
        created_at AS createdAt
      FROM audit_logs
      WHERE event_id = ?
      ORDER BY id DESC
      LIMIT 1
    `);

    return statement.get(eventId) as AuditLogRecord | undefined;
  }

  listByTaskId(taskId: string) {
    const statement = this.db.prepare(`
      SELECT
        event_id AS eventId,
        task_id AS taskId,
        session_id AS sessionId,
        action,
        actor_id AS actorId,
        result,
        detail,
        created_at AS createdAt
      FROM audit_logs
      WHERE task_id = ?
      ORDER BY created_at ASC, id ASC
    `);

    return statement.all(taskId) as AuditLogRecord[];
  }

  listBySessionId(sessionId: string, limit: number) {
    const statement = this.db.prepare(`
      SELECT
        event_id AS eventId,
        task_id AS taskId,
        session_id AS sessionId,
        action,
        actor_id AS actorId,
        result,
        detail,
        created_at AS createdAt
      FROM audit_logs
      WHERE session_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `);

    return statement.all(sessionId, limit) as AuditLogRecord[];
  }
}
