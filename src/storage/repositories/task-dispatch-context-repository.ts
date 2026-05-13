/**
 * @description 任务调度上下文仓储，持久化 thread、项目路径和模型参数，供风控确认后恢复调度
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-05-10 14:05
 */
import type { SqliteDatabase } from "../sqlite";

export type TaskDispatchContextRecord = {
  taskId: string;
  sessionId: string;
  threadRef: string | null;
  projectPath: string | null;
  modelSlug: string | null;
  modelReasoningLevel: string | null;
  createdAt: string;
  updatedAt: string;
};

export class TaskDispatchContextRepository {
  constructor(private readonly db: SqliteDatabase) {}

  upsert(record: TaskDispatchContextRecord) {
    const statement = this.db.prepare(`
      INSERT INTO task_dispatch_contexts (
        task_id, session_id, thread_ref, project_path, model_slug, model_reasoning_level, created_at, updated_at
      ) VALUES (
        @taskId, @sessionId, @threadRef, @projectPath, @modelSlug, @modelReasoningLevel, @createdAt, @updatedAt
      )
      ON CONFLICT(task_id) DO UPDATE SET
        session_id = excluded.session_id,
        thread_ref = excluded.thread_ref,
        project_path = excluded.project_path,
        model_slug = excluded.model_slug,
        model_reasoning_level = excluded.model_reasoning_level,
        updated_at = excluded.updated_at
    `);

    statement.run(record);
    return this.findByTaskId(record.taskId);
  }

  findByTaskId(taskId: string) {
    const statement = this.db.prepare(`
      SELECT
        task_id AS taskId,
        session_id AS sessionId,
        thread_ref AS threadRef,
        project_path AS projectPath,
        model_slug AS modelSlug,
        model_reasoning_level AS modelReasoningLevel,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM task_dispatch_contexts
      WHERE task_id = ?
      LIMIT 1
    `);

    return statement.get(taskId) as TaskDispatchContextRecord | undefined;
  }
}
