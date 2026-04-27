import type { SqliteDatabase } from "../sqlite";

export type TaskRecord = {
  taskId: string;
  sessionId: string;
  triggerMessageId: string | null;
  taskType: string;
  status: string;
  summary: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export class TaskRepository {
  constructor(private readonly db: SqliteDatabase) {}

  create(record: TaskRecord) {
    const statement = this.db.prepare(`
      INSERT INTO tasks (
        task_id, session_id, trigger_message_id, task_type, status, summary, started_at, finished_at
      ) VALUES (
        @taskId, @sessionId, @triggerMessageId, @taskType, @status, @summary, @startedAt, @finishedAt
      )
    `);

    statement.run(record);
    return this.findByTaskId(record.taskId);
  }

  findByTaskId(taskId: string) {
    const statement = this.db.prepare(`
      SELECT
        task_id AS taskId,
        session_id AS sessionId,
        trigger_message_id AS triggerMessageId,
        task_type AS taskType,
        status,
        summary,
        started_at AS startedAt,
        finished_at AS finishedAt
      FROM tasks
      WHERE task_id = ?
    `);

    return statement.get(taskId) as TaskRecord | undefined;
  }

  listRecent(limit: number) {
    const statement = this.db.prepare(`
      SELECT
        task_id AS taskId,
        session_id AS sessionId,
        trigger_message_id AS triggerMessageId,
        task_type AS taskType,
        status,
        summary,
        started_at AS startedAt,
        finished_at AS finishedAt
      FROM tasks
      ORDER BY COALESCE(finished_at, started_at) DESC, id DESC
      LIMIT ?
    `);

    return statement.all(limit) as TaskRecord[];
  }

  findManyBySessionId(sessionId: string, limit: number) {
    const statement = this.db.prepare(`
      SELECT
        task_id AS taskId,
        session_id AS sessionId,
        trigger_message_id AS triggerMessageId,
        task_type AS taskType,
        status,
        summary,
        started_at AS startedAt,
        finished_at AS finishedAt
      FROM tasks
      WHERE session_id = ?
      ORDER BY COALESCE(finished_at, started_at) DESC, id DESC
      LIMIT ?
    `);

    return statement.all(sessionId, limit) as TaskRecord[];
  }

  countByStatus(status: string) {
    const statement = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM tasks
      WHERE status = ?
    `);

    const result = statement.get(status) as { count: number };
    return result.count;
  }

  countFailedSince(startedAt: string) {
    const statement = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM tasks
      WHERE status = 'failed'
        AND started_at >= ?
    `);

    const result = statement.get(startedAt) as { count: number };
    return result.count;
  }

  updateStatus(taskId: string, status: string, finishedAt: string | null) {
    const statement = this.db.prepare(`
      UPDATE tasks
      SET status = @status,
          finished_at = @finishedAt
      WHERE task_id = @taskId
    `);

    statement.run({
      taskId,
      status,
      finishedAt
    });

    return this.findByTaskId(taskId);
  }

  updateStatusAndSummary(taskId: string, status: string, finishedAt: string | null, summary: string | null) {
    const statement = this.db.prepare(`
      UPDATE tasks
      SET status = @status,
          finished_at = @finishedAt,
          summary = @summary
      WHERE task_id = @taskId
    `);

    statement.run({
      taskId,
      status,
      finishedAt,
      summary
    });

    return this.findByTaskId(taskId);
  }

  countActiveBySessionId(sessionId: string) {
    const statement = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM tasks
      WHERE session_id = ?
        AND status IN ('running', 'pending_confirm')
    `);

    const result = statement.get(sessionId) as { count: number };
    return result.count;
  }

  listByStatuses(statuses: string[], limit: number) {
    if (statuses.length === 0) {
      return this.listRecent(limit);
    }

    const placeholders = statuses.map(() => "?").join(", ");
    const statement = this.db.prepare(`
      SELECT
        task_id AS taskId,
        session_id AS sessionId,
        trigger_message_id AS triggerMessageId,
        task_type AS taskType,
        status,
        summary,
        started_at AS startedAt,
        finished_at AS finishedAt
      FROM tasks
      WHERE status IN (${placeholders})
      ORDER BY COALESCE(finished_at, started_at) DESC, id DESC
      LIMIT ?
    `);

    return statement.all(...statuses, limit) as TaskRecord[];
  }

  listByToolProviderAndStatuses(toolProvider: string, statuses: string[], limit: number, sinceAt?: string) {
    const conditions = ["s.tool_provider = ?"];
    const params: Array<string | number> = [toolProvider];

    if (statuses.length > 0) {
      const placeholders = statuses.map(() => "?").join(", ");
      conditions.push(`t.status IN (${placeholders})`);
      params.push(...statuses);
    }

    if (sinceAt) {
      conditions.push("COALESCE(t.finished_at, t.started_at) >= ?");
      params.push(sinceAt);
    }

    const statement = this.db.prepare(`
      SELECT
        t.task_id AS taskId,
        t.session_id AS sessionId,
        t.trigger_message_id AS triggerMessageId,
        t.task_type AS taskType,
        t.status AS status,
        t.summary AS summary,
        t.started_at AS startedAt,
        t.finished_at AS finishedAt
      FROM tasks t
      JOIN tool_sessions s ON s.session_id = t.session_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY COALESCE(t.finished_at, t.started_at) DESC, t.id DESC
      LIMIT ?
    `);

    params.push(limit);
    return statement.all(...params) as TaskRecord[];
  }

  countByToolProviderAndStatuses(toolProvider: string, statuses: string[], sinceAt?: string) {
    const conditions = ["s.tool_provider = ?"];
    const params: string[] = [toolProvider];

    if (statuses.length > 0) {
      const placeholders = statuses.map(() => "?").join(", ");
      conditions.push(`t.status IN (${placeholders})`);
      params.push(...statuses);
    }

    if (sinceAt) {
      conditions.push("COALESCE(t.finished_at, t.started_at) >= ?");
      params.push(sinceAt);
    }

    const statement = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM tasks t
      JOIN tool_sessions s ON s.session_id = t.session_id
      WHERE ${conditions.join(" AND ")}
    `);

    const result = statement.get(...params) as { count: number };
    return result.count;
  }
}
