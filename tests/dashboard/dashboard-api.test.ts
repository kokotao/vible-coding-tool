import { buildApp } from "../../src/app";
import { createSqliteDatabase, migrateDatabase } from "../../src/storage/sqlite";
import { seedAppData } from "../helpers/seed-app-data";

describe("dashboard summary api", () => {
  it("returns aggregate dashboard payload", async () => {
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
      url: "/api/dashboard/summary"
    });

    expect(response.statusCode).toBe(200);

    const payload = response.json();
    expect(payload.summary).toMatchObject({
      runningTaskCount: 1,
      pendingRiskCount: 1,
      activeSessionCount: 2
    });
    expect(payload.summary.failedTaskCountToday).toBeTypeOf("number");
    expect(payload.summary.failedTaskCountToday).toBeGreaterThanOrEqual(0);
    expect(payload.taskTimeline).toHaveLength(3);
    expect(payload.activeSessions[0].taskTitle).toBeTruthy();
    expect(payload.pendingRisks[0].taskId).toBe("task-2");
    expect(payload.connectors).toHaveLength(2);

    await app.close();
  });
});
