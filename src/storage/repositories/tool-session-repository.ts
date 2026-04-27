import type { SqliteDatabase } from "../sqlite";

export type ToolSessionRecord = {
  sessionId: string;
  toolProvider: string;
  toolSessionRef: string;
  status: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export class ToolSessionRepository {
  constructor(private readonly db: SqliteDatabase) {}

  create(record: ToolSessionRecord) {
    const statement = this.db.prepare(`
      INSERT INTO tool_sessions (
        session_id, tool_provider, tool_session_ref, status, created_by, created_at, updated_at
      ) VALUES (
        @sessionId, @toolProvider, @toolSessionRef, @status, @createdBy, @createdAt, @updatedAt
      )
    `);

    statement.run(record);
    return this.findBySessionId(record.sessionId);
  }

  upsert(record: ToolSessionRecord) {
    const statement = this.db.prepare(`
      INSERT INTO tool_sessions (
        session_id, tool_provider, tool_session_ref, status, created_by, created_at, updated_at
      ) VALUES (
        @sessionId, @toolProvider, @toolSessionRef, @status, @createdBy, @createdAt, @updatedAt
      )
      ON CONFLICT(session_id) DO UPDATE SET
        tool_provider = excluded.tool_provider,
        tool_session_ref = excluded.tool_session_ref,
        status = excluded.status,
        created_by = COALESCE(excluded.created_by, tool_sessions.created_by),
        updated_at = excluded.updated_at
    `);

    statement.run(record);
    return this.findBySessionId(record.sessionId);
  }

  findBySessionId(sessionId: string) {
    const statement = this.db.prepare(`
      SELECT
        session_id AS sessionId,
        tool_provider AS toolProvider,
        tool_session_ref AS toolSessionRef,
        status,
        created_by AS createdBy,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM tool_sessions
      WHERE session_id = ?
    `);

    return statement.get(sessionId) as ToolSessionRecord | undefined;
  }

  listActive(limit: number) {
    const statement = this.db.prepare(`
      SELECT
        session_id AS sessionId,
        tool_provider AS toolProvider,
        tool_session_ref AS toolSessionRef,
        status,
        created_by AS createdBy,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM tool_sessions
      WHERE status != 'closed'
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `);

    return statement.all(limit) as ToolSessionRecord[];
  }

  countActive() {
    const statement = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM tool_sessions
      WHERE status != 'closed'
    `);

    const result = statement.get() as { count: number };
    return result.count;
  }

  updateStatus(sessionId: string, status: string, updatedAt: string) {
    const statement = this.db.prepare(`
      UPDATE tool_sessions
      SET status = @status,
          updated_at = @updatedAt
      WHERE session_id = @sessionId
    `);

    statement.run({
      sessionId,
      status,
      updatedAt
    });

    return this.findBySessionId(sessionId);
  }

  listByToolProvider(toolProvider: string, limit: number, sinceUpdatedAt?: string) {
    const conditions = ["tool_provider = ?"];
    const params: Array<string | number> = [toolProvider];

    if (sinceUpdatedAt) {
      conditions.push("updated_at >= ?");
      params.push(sinceUpdatedAt);
    }

    const statement = this.db.prepare(`
      SELECT
        session_id AS sessionId,
        tool_provider AS toolProvider,
        tool_session_ref AS toolSessionRef,
        status,
        created_by AS createdBy,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM tool_sessions
      WHERE ${conditions.join(" AND ")}
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `);

    params.push(limit);
    return statement.all(...params) as ToolSessionRecord[];
  }

  listByToolProviderAndStatuses(toolProvider: string, statuses: string[], limit: number, sinceUpdatedAt?: string) {
    if (statuses.length === 0) {
      return this.listByToolProvider(toolProvider, limit, sinceUpdatedAt);
    }

    const conditions = ["tool_provider = ?"];
    const params: Array<string | number> = [toolProvider];
    const placeholders = statuses.map(() => "?").join(", ");
    conditions.push(`status IN (${placeholders})`);
    params.push(...statuses);

    if (sinceUpdatedAt) {
      conditions.push("updated_at >= ?");
      params.push(sinceUpdatedAt);
    }

    const statement = this.db.prepare(`
      SELECT
        session_id AS sessionId,
        tool_provider AS toolProvider,
        tool_session_ref AS toolSessionRef,
        status,
        created_by AS createdBy,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM tool_sessions
      WHERE ${conditions.join(" AND ")}
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `);

    params.push(limit);
    return statement.all(...params) as ToolSessionRecord[];
  }

  countByToolProviderAndStatuses(toolProvider: string, statuses: string[], sinceUpdatedAt?: string) {
    const conditions = ["tool_provider = ?"];
    const params: string[] = [toolProvider];

    if (statuses.length > 0) {
      const placeholders = statuses.map(() => "?").join(", ");
      conditions.push(`status IN (${placeholders})`);
      params.push(...statuses);
    }

    if (sinceUpdatedAt) {
      conditions.push("updated_at >= ?");
      params.push(sinceUpdatedAt);
    }

    const statement = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM tool_sessions
      WHERE ${conditions.join(" AND ")}
    `);

    const result = statement.get(...params) as { count: number };
    return result.count;
  }
}
