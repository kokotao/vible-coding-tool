import { buildApp } from "../../src/app";
import { createSqliteDatabase, migrateDatabase } from "../../src/storage/sqlite";

describe("connector config api", () => {
  it("returns default connector config", async () => {
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
      url: "/api/connectors/feishu/config"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      platform: "feishu",
      enabled: false,
      eventMode: "webhook",
      sessionPrefix: "feishu-codex"
    });

    await app.close();
  });

  it("updates and tests connector config", async () => {
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent"
      }
    });

    const updateResponse = await app.inject({
      method: "PUT",
      url: "/api/connectors/feishu/config",
      payload: {
        platform: "feishu",
        enabled: false,
        appId: "cli_xxx",
        appSecret: "secret_xxx",
        eventMode: "websocket",
        callbackUrl: "http://127.0.0.1:3000/api/feishu/webhook",
        defaultChannelName: "研发群",
        confirmTimeoutSeconds: 180,
        riskKeywords: ["删除", "强制推送"],
        templateTaskStarted: "任务开始",
        templateTaskSucceeded: "任务成功",
        templateTaskFailed: "任务失败",
        templateTaskPendingConfirm: "请确认",
        sessionPrefix: "feishu-codex"
      }
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      platform: "feishu",
      appId: "cli_xxx",
      eventMode: "websocket",
      defaultChannelName: "研发群"
    });

    const testResponse = await app.inject({
      method: "POST",
      url: "/api/connectors/feishu/test"
    });

    expect(testResponse.statusCode).toBe(200);
    expect(testResponse.json()).toEqual(
      expect.objectContaining({
        platform: "feishu",
        success: true,
        lastTestResult: "success"
      })
    );

    await app.close();
  });

  it("accepts qq websocket mode and passes connection test with app credentials", async () => {
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent"
      }
    });

    const current = (
      await app.inject({
        method: "GET",
        url: "/api/connectors/qq/config"
      })
    ).json();

    const updateResponse = await app.inject({
      method: "PUT",
      url: "/api/connectors/qq/config",
      payload: {
        ...current,
        platform: "qq",
        enabled: false,
        appId: "qq_app_id",
        appSecret: "qq_app_secret",
        eventMode: "websocket",
        callbackUrl: "http://127.0.0.1:3000/api/feishu/webhook"
      }
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toEqual(
      expect.objectContaining({
        platform: "qq",
        eventMode: "websocket"
      })
    );

    const testResponse = await app.inject({
      method: "POST",
      url: "/api/connectors/qq/test"
    });

    expect(testResponse.statusCode).toBe(200);
    expect(testResponse.json()).toEqual(
      expect.objectContaining({
        platform: "qq",
        success: true,
        lastTestResult: "success",
        message: expect.stringContaining("QQ websocket mode")
      })
    );

    await app.close();
  });
});
