/**
 * @description 飞书指令面板上下文仓储，维护 open_id 对应的项目/session/model 选择状态
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-27 21:40
 */
import type { SqliteDatabase } from "../sqlite";

export type FeishuPanelCurrentView =
  | "home"
  | "project_list"
  | "session_list"
  | "model_list"
  | "gateway_status"
  | "selection";

export type FeishuPanelComposeMode = "session_command" | "thread_command" | "project_session_command";

export type FeishuPanelContextRecord = {
  openId: string;
  currentView: FeishuPanelCurrentView;
  selectedProjectName: string | null;
  selectedProjectPath: string | null;
  selectedThreadId: string | null;
  selectedSessionTitle: string | null;
  selectedModelSlug: string | null;
  selectedModelName: string | null;
  selectedReasoningLevel: string | null;
  pendingComposeMode: FeishuPanelComposeMode | null;
  lastAction: string | null;
  updatedAt: string;
};

type FeishuPanelContextRow = {
  openId: string;
  currentView: FeishuPanelCurrentView;
  selectedProjectName: string | null;
  selectedProjectPath: string | null;
  selectedThreadId: string | null;
  selectedSessionTitle: string | null;
  selectedModelSlug: string | null;
  selectedModelName: string | null;
  selectedReasoningLevel: string | null;
  pendingComposeMode: FeishuPanelComposeMode | null;
  lastAction: string | null;
  updatedAt: string;
};

export class FeishuPanelContextRepository {
  constructor(private readonly db: SqliteDatabase) {}

  findByOpenId(openId: string) {
    const statement = this.db.prepare(`
      SELECT
        open_id AS openId,
        current_view AS currentView,
        selected_project_name AS selectedProjectName,
        selected_project_path AS selectedProjectPath,
        selected_thread_id AS selectedThreadId,
        selected_session_title AS selectedSessionTitle,
        selected_model_slug AS selectedModelSlug,
        selected_model_name AS selectedModelName,
        selected_reasoning_level AS selectedReasoningLevel,
        pending_compose_mode AS pendingComposeMode,
        last_action AS lastAction,
        updated_at AS updatedAt
      FROM feishu_panel_contexts
      WHERE open_id = ?
      LIMIT 1
    `);

    const row = statement.get(openId.trim()) as FeishuPanelContextRow | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  upsert(record: FeishuPanelContextRecord) {
    const statement = this.db.prepare(`
      INSERT INTO feishu_panel_contexts (
        open_id,
        current_view,
        selected_project_name,
        selected_project_path,
        selected_thread_id,
        selected_session_title,
        selected_model_slug,
        selected_model_name,
        selected_reasoning_level,
        pending_compose_mode,
        last_action,
        updated_at
      ) VALUES (
        @openId,
        @currentView,
        @selectedProjectName,
        @selectedProjectPath,
        @selectedThreadId,
        @selectedSessionTitle,
        @selectedModelSlug,
        @selectedModelName,
        @selectedReasoningLevel,
        @pendingComposeMode,
        @lastAction,
        @updatedAt
      )
      ON CONFLICT(open_id) DO UPDATE SET
        current_view = excluded.current_view,
        selected_project_name = excluded.selected_project_name,
        selected_project_path = excluded.selected_project_path,
        selected_thread_id = excluded.selected_thread_id,
        selected_session_title = excluded.selected_session_title,
        selected_model_slug = excluded.selected_model_slug,
        selected_model_name = excluded.selected_model_name,
        selected_reasoning_level = excluded.selected_reasoning_level,
        pending_compose_mode = excluded.pending_compose_mode,
        last_action = excluded.last_action,
        updated_at = excluded.updated_at
    `);

    statement.run({
      openId: record.openId.trim(),
      currentView: record.currentView,
      selectedProjectName: record.selectedProjectName?.trim() || null,
      selectedProjectPath: record.selectedProjectPath?.trim() || null,
      selectedThreadId: record.selectedThreadId?.trim() || null,
      selectedSessionTitle: record.selectedSessionTitle?.trim() || null,
      selectedModelSlug: record.selectedModelSlug?.trim() || null,
      selectedModelName: record.selectedModelName?.trim() || null,
      selectedReasoningLevel: record.selectedReasoningLevel?.trim() || null,
      pendingComposeMode: record.pendingComposeMode || null,
      lastAction: record.lastAction?.trim() || null,
      updatedAt: record.updatedAt
    });

    return this.findByOpenId(record.openId);
  }

  updateSelection(
    openId: string,
    patch: Partial<Omit<FeishuPanelContextRecord, "openId" | "updatedAt">> & {
      currentView?: FeishuPanelCurrentView;
      updatedAt: string;
    }
  ) {
    const existing = this.findByOpenId(openId) ?? this.createDefault(openId, patch.updatedAt);
    return this.upsert({
      ...existing,
      ...patch,
      openId,
      updatedAt: patch.updatedAt
    });
  }

  private createDefault(openId: string, updatedAt: string): FeishuPanelContextRecord {
    return {
      openId: openId.trim(),
      currentView: "home",
      selectedProjectName: null,
      selectedProjectPath: null,
      selectedThreadId: null,
      selectedSessionTitle: null,
      selectedModelSlug: null,
      selectedModelName: null,
      selectedReasoningLevel: null,
      pendingComposeMode: null,
      lastAction: null,
      updatedAt
    };
  }

  private mapRow(row: FeishuPanelContextRow): FeishuPanelContextRecord {
    return {
      openId: row.openId,
      currentView: row.currentView,
      selectedProjectName: row.selectedProjectName,
      selectedProjectPath: row.selectedProjectPath,
      selectedThreadId: row.selectedThreadId,
      selectedSessionTitle: row.selectedSessionTitle,
      selectedModelSlug: row.selectedModelSlug,
      selectedModelName: row.selectedModelName,
      selectedReasoningLevel: row.selectedReasoningLevel,
      pendingComposeMode: row.pendingComposeMode,
      lastAction: row.lastAction,
      updatedAt: row.updatedAt
    };
  }
}
