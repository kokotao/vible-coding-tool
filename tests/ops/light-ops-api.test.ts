import { buildApp } from "../../src/app";
import { createSqliteDatabase, migrateDatabase } from "../../src/storage/sqlite";
import { seedAppData } from "../helpers/seed-app-data";
import { createFetchMock } from "../helpers/fetch-mock";

function createFeishuOpenApiMock() {
  const authBodies: string[] = [];
  const messageBodies: string[] = [];
  const { fetchImpl } = createFetchMock([
    {
      match: /\/open-apis\/auth\/v3\/tenant_access_token\/internal$/,
      response: ({ bodyText }) => {
        authBodies.push(bodyText);
        return new Response(
          JSON.stringify({
            code: 0,
            tenant_access_token: "token-demo",
            expire: 7200
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }
    },
    {
      match: /\/open-apis\/im\/v1\/messages/,
      response: ({ bodyText }) => {
        messageBodies.push(bodyText);
        return new Response(JSON.stringify({ code: 0 }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }
    }
  ]);

  return {
    authBodies,
    fetchImpl,
    messageBodies
  };
}

describe("light ops api", () => {
  it("stops a running task from dashboard operation", async () => {
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
      method: "POST",
      url: "/api/tasks/task-1/stop"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      taskId: "task-1",
      status: "stopped",
      changed: true
    });

    const taskDetail = await app.inject({
      method: "GET",
      url: "/api/tasks/task-1/detail"
    });
    expect(taskDetail.statusCode).toBe(200);
    expect(taskDetail.json().status).toBe("stopped");

    const sessionDetail = await app.inject({
      method: "GET",
      url: "/api/sessions/feishu-codex-0001/detail"
    });
    expect(sessionDetail.statusCode).toBe(200);
    expect(sessionDetail.json().status).toBe("paused");

    await app.close();
  });

  it("records approval but marks task failed when high risk command cannot be resumed", async () => {
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
      method: "POST",
      url: "/api/risks/confirm-task-2/confirm"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: false,
      taskId: "task-2",
      riskStatus: "approved",
      taskStatus: "failed"
    });

    const dashboard = await app.inject({
      method: "GET",
      url: "/api/dashboard/summary"
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().summary.pendingRiskCount).toBe(0);
    expect(dashboard.json().summary.runningTaskCount).toBe(1);

    const taskDetail = await app.inject({
      method: "GET",
      url: "/api/tasks/task-2/detail"
    });
    expect(taskDetail.statusCode).toBe(200);
    expect(taskDetail.json().status).toBe("failed");
    expect(taskDetail.json().riskRecords[0].status).toBe("approved");
    expect(taskDetail.json().riskRecords[0].confirmedBy).toBe("web_console");

    const sessionDetail = await app.inject({
      method: "GET",
      url: "/api/sessions/feishu-codex-0002/detail"
    });
    expect(sessionDetail.statusCode).toBe(200);
    expect(sessionDetail.json().status).toBe("paused");

    await app.close();
  });

  it("rejects pending high risk command", async () => {
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
      method: "POST",
      url: "/api/risks/confirm-task-2/reject"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      taskId: "task-2",
      riskStatus: "rejected",
      taskStatus: "rejected"
    });

    const sessionDetail = await app.inject({
      method: "GET",
      url: "/api/sessions/feishu-codex-0002/detail"
    });
    expect(sessionDetail.statusCode).toBe(200);
    expect(sessionDetail.json().status).toBe("closed");

    const dashboard = await app.inject({
      method: "GET",
      url: "/api/dashboard/summary"
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().summary.pendingRiskCount).toBe(0);

    await app.close();
  });

  it("enqueues manual retry notification", async () => {
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
      method: "POST",
      url: "/api/tasks/task-1/retry-notify"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      taskId: "task-1",
      message: "Retry notification queued"
    });

    const taskDetail = await app.inject({
      method: "GET",
      url: "/api/tasks/task-1/detail"
    });
    expect(taskDetail.statusCode).toBe(200);
    const lastMessage = taskDetail.json().messageTimeline.at(-1);
    expect(lastMessage?.messageType).toBe("manual_notify");

    await app.close();
  });

  it("pushes outbound text via feishu open api when connector is enabled", async () => {
    const mockFeishu = createFeishuOpenApiMock();
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);
    seedAppData(db);

    const app = buildApp({
      db,
      fetchImpl: mockFeishu.fetchImpl,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuOpenBaseUrl: "http://mock.feishu"
      }
    });

    try {
      const configResponse = await app.inject({
        method: "GET",
        url: "/api/connectors/feishu/config"
      });

      const currentConfig = configResponse.json();
      const updateResponse = await app.inject({
        method: "PUT",
        url: "/api/connectors/feishu/config",
        payload: {
          ...currentConfig,
          enabled: true,
          appId: "app-id",
          appSecret: "app-secret",
          callbackUrl: ""
        }
      });

      expect(updateResponse.statusCode).toBe(200);

      const response = await app.inject({
        method: "POST",
        url: "/api/tasks/task-1/retry-notify",
        payload: {
          actorId: "ou_test_sender"
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().notify).toMatchObject({
        sent: true,
        skipped: false,
        statusCode: 200
      });
      expect(mockFeishu.authBodies).toHaveLength(1);
      expect(mockFeishu.messageBodies).toHaveLength(1);

      const payload = JSON.parse(mockFeishu.messageBodies[0]) as {
        receive_id: string;
        msg_type: string;
        content: string;
      };
      expect(payload.receive_id).toBe("ou_test_sender");
      expect(payload.msg_type).toBe("text");
      expect(payload.content).toContain("Task=task-1");
    } finally {
      await app.close();
    }
  });
});
