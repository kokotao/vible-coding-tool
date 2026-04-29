import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";

const MIGRATION_PATH = resolve(__dirname, "migrations", "001_init.sql");

export type SqliteDatabase = Database.Database;

export function resolveDatabasePath(databasePath: string) {
  if (databasePath === ":memory:") {
    return databasePath;
  }

  return resolve(process.cwd(), databasePath);
}

export function createSqliteDatabase(databasePath: string): SqliteDatabase {
  const resolvedPath = resolveDatabasePath(databasePath);

  if (resolvedPath !== ":memory:") {
    mkdirSync(dirname(resolvedPath), { recursive: true });
  }

  return new Database(resolvedPath);
}

export function migrateDatabase(db: SqliteDatabase) {
  const migration = readFileSync(MIGRATION_PATH, "utf8");
  db.exec(migration);
  ensureAuditLogTaskIdColumn(db);
  ensureFeishuPanelContextColumns(db);
  ensureFeishuSessionRoutesTable(db);
}

function ensureAuditLogTaskIdColumn(db: SqliteDatabase) {
  const columns = db.prepare("PRAGMA table_info(audit_logs)").all() as Array<{ name: string }>;
  const hasTaskId = columns.some((column) => column.name === "task_id");

  if (!hasTaskId) {
    db.exec("ALTER TABLE audit_logs ADD COLUMN task_id TEXT");
  }
}

function ensureFeishuPanelContextColumns(db: SqliteDatabase) {
  const columns = db.prepare("PRAGMA table_info(feishu_panel_contexts)").all() as Array<{ name: string }>;
  const hasPendingComposeMode = columns.some((column) => column.name === "pending_compose_mode");
  const hasSelectedReasoningLevel = columns.some((column) => column.name === "selected_reasoning_level");

  if (!hasPendingComposeMode) {
    db.exec("ALTER TABLE feishu_panel_contexts ADD COLUMN pending_compose_mode TEXT");
  }

  if (!hasSelectedReasoningLevel) {
    db.exec("ALTER TABLE feishu_panel_contexts ADD COLUMN selected_reasoning_level TEXT");
  }
}

function ensureFeishuSessionRoutesTable(db: SqliteDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS feishu_session_routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      source_platform TEXT NOT NULL,
      chat_type TEXT NOT NULL,
      chat_id TEXT,
      sender_open_id TEXT NOT NULL,
      last_platform_message_id TEXT,
      route_status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}
