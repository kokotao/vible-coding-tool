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
}

function ensureAuditLogTaskIdColumn(db: SqliteDatabase) {
  const columns = db.prepare("PRAGMA table_info(audit_logs)").all() as Array<{ name: string }>;
  const hasTaskId = columns.some((column) => column.name === "task_id");

  if (!hasTaskId) {
    db.exec("ALTER TABLE audit_logs ADD COLUMN task_id TEXT");
  }
}
