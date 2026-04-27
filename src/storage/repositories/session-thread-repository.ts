/**
 * @description 会话线程绑定仓储，维护 session 下 Codex thread 与线程别名（A/B/C...）映射
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-26 23:34
 */
import type { SqliteDatabase } from "../sqlite";

export type SessionThreadRecord = {
  sessionId: string;
  threadRef: string;
  threadAlias: string;
  threadName: string | null;
  lastTaskId: string | null;
  lastSummary: string | null;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};

type SessionThreadRow = {
  sessionId: string;
  threadRef: string;
  threadAlias: string;
  threadName: string | null;
  lastTaskId: string | null;
  lastSummary: string | null;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};

export class SessionThreadRepository {
  constructor(private readonly db: SqliteDatabase) {}

  findBySessionAndRef(sessionId: string, threadRef: string) {
    const statement = this.db.prepare(`
      SELECT
        session_id AS sessionId,
        thread_ref AS threadRef,
        thread_alias AS threadAlias,
        thread_name AS threadName,
        last_task_id AS lastTaskId,
        last_summary AS lastSummary,
        last_seen_at AS lastSeenAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM session_threads
      WHERE session_id = ?
        AND thread_ref = ?
      LIMIT 1
    `);

    return statement.get(sessionId, threadRef) as SessionThreadRow | undefined;
  }

  findBySessionAndAlias(sessionId: string, threadAlias: string) {
    const normalized = this.normalizeAlias(threadAlias);
    const statement = this.db.prepare(`
      SELECT
        session_id AS sessionId,
        thread_ref AS threadRef,
        thread_alias AS threadAlias,
        thread_name AS threadName,
        last_task_id AS lastTaskId,
        last_summary AS lastSummary,
        last_seen_at AS lastSeenAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM session_threads
      WHERE session_id = ?
        AND thread_alias = ?
      LIMIT 1
    `);

    return statement.get(sessionId, normalized) as SessionThreadRow | undefined;
  }

  findBySessionAndRefPrefix(sessionId: string, threadRefPrefix: string, limit = 10) {
    const normalizedPrefix = threadRefPrefix.trim();
    if (!normalizedPrefix) {
      return [];
    }

    const statement = this.db.prepare(`
      SELECT
        session_id AS sessionId,
        thread_ref AS threadRef,
        thread_alias AS threadAlias,
        thread_name AS threadName,
        last_task_id AS lastTaskId,
        last_summary AS lastSummary,
        last_seen_at AS lastSeenAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM session_threads
      WHERE session_id = ?
        AND thread_ref LIKE ?
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `);

    return statement.all(sessionId, `${normalizedPrefix}%`, limit) as SessionThreadRow[];
  }

  listBySession(sessionId: string, limit = 20) {
    const statement = this.db.prepare(`
      SELECT
        session_id AS sessionId,
        thread_ref AS threadRef,
        thread_alias AS threadAlias,
        thread_name AS threadName,
        last_task_id AS lastTaskId,
        last_summary AS lastSummary,
        last_seen_at AS lastSeenAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM session_threads
      WHERE session_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `);

    return statement.all(sessionId, limit) as SessionThreadRow[];
  }

  upsertByEvent(input: {
    sessionId: string;
    threadRef: string;
    taskId: string | null;
    summary: string | null;
    seenAt: string;
  }) {
    const existing = this.findBySessionAndRef(input.sessionId, input.threadRef);
    const inferredThreadName = this.inferThreadName(input.summary);

    if (existing) {
      const statement = this.db.prepare(`
        UPDATE session_threads
        SET last_task_id = @lastTaskId,
            last_summary = @lastSummary,
            thread_name = COALESCE(@threadName, thread_name),
            last_seen_at = @lastSeenAt,
            updated_at = @updatedAt
        WHERE session_id = @sessionId
          AND thread_ref = @threadRef
      `);

      statement.run({
        sessionId: input.sessionId,
        threadRef: input.threadRef,
        lastTaskId: input.taskId,
        lastSummary: input.summary,
        threadName: inferredThreadName,
        lastSeenAt: input.seenAt,
        updatedAt: input.seenAt
      });

      return this.findBySessionAndRef(input.sessionId, input.threadRef)!;
    }

    const alias = this.allocateAlias(input.sessionId);
    const statement = this.db.prepare(`
      INSERT INTO session_threads (
        session_id, thread_ref, thread_alias, thread_name, last_task_id,
        last_summary, last_seen_at, created_at, updated_at
      ) VALUES (
        @sessionId, @threadRef, @threadAlias, @threadName, @lastTaskId,
        @lastSummary, @lastSeenAt, @createdAt, @updatedAt
      )
    `);

    statement.run({
      sessionId: input.sessionId,
      threadRef: input.threadRef,
      threadAlias: alias,
      threadName: inferredThreadName,
      lastTaskId: input.taskId,
      lastSummary: input.summary,
      lastSeenAt: input.seenAt,
      createdAt: input.seenAt,
      updatedAt: input.seenAt
    });

    return this.findBySessionAndRef(input.sessionId, input.threadRef)!;
  }

  private allocateAlias(sessionId: string) {
    const statement = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM session_threads
      WHERE session_id = ?
    `);

    const result = statement.get(sessionId) as { count: number };
    return this.normalizeAlias(this.numberToAlias(result.count + 1));
  }

  private numberToAlias(sequence: number) {
    let value = sequence;
    let output = "";

    while (value > 0) {
      const remainder = (value - 1) % 26;
      output = String.fromCharCode(65 + remainder) + output;
      value = Math.floor((value - 1) / 26);
    }

    return output || "A";
  }

  private normalizeAlias(value: string) {
    return value.trim().replace(/^线程/i, "").toUpperCase();
  }

  private inferThreadName(summary: string | null) {
    const text = (summary || "")
      .replace(/^Codex任务完成[:：]\s*/i, "")
      .replace(/^任务完成[:：]\s*/i, "")
      .replace(/^任务失败[:：]\s*/i, "")
      .replace(/^任务开始[:：]\s*/i, "")
      .trim();

    if (!text) {
      return null;
    }

    if (text.length <= 40) {
      return text;
    }

    return `${text.slice(0, 37)}...`;
  }
}
