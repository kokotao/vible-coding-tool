import { buildApp } from "../../src/app";
import { createSqliteDatabase, migrateDatabase } from "../../src/storage/sqlite";
import { seedAppData } from "../helpers/seed-app-data";

describe("session detail api", () => {
  it("returns session detail payload", async () => {
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
      url: "/api/sessions/feishu-codex-0001/detail"
    });

    expect(response.statusCode).toBe(200);

    const payload = response.json();
    expect(payload.sessionId).toBe("feishu-codex-0001");
    expect(payload.recentTasks[0].taskId).toBe("task-1");
    expect(payload.messageTimeline).toHaveLength(2);
    expect(payload.bindings.sessionPrefix).toBe("feishu-codex");

    await app.close();
  });
});
