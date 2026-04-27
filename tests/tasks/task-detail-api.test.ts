import { buildApp } from "../../src/app";
import { createSqliteDatabase, migrateDatabase } from "../../src/storage/sqlite";
import { seedAppData } from "../helpers/seed-app-data";

describe("task detail api", () => {
  it("returns task detail payload with timeline and audit logs", async () => {
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);
    seedAppData(db);

    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent"
      }
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/tasks/task-1/detail"
    });

    expect(response.statusCode).toBe(200);

    const payload = response.json();
    expect(payload.taskId).toBe("task-1");
    expect(payload.taskTitle).toContain("修复登录接口");
    expect(payload.messageTimeline).toHaveLength(2);
    expect(payload.auditLogs).toHaveLength(2);
    expect(payload.toolProvider).toBe("codex");

    await app.close();
  });

  it("returns 404 for missing task detail", async () => {
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent"
      }
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/tasks/missing-task/detail"
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      code: "TASK_NOT_FOUND",
      message: "Task missing-task not found"
    });

    await app.close();
  });
});
