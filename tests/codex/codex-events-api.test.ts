import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { buildApp } from "../../src/app";
import { TaskRepository } from "../../src/storage/repositories/task-repository";
import { ToolSessionRepository } from "../../src/storage/repositories/tool-session-repository";
import { createSqliteDatabase, migrateDatabase } from "../../src/storage/sqlite";

function createSignedHeaders(secret: string, payload: unknown, timestamp: number, nonce: string) {
  const rawBody = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${nonce}.${rawBody}`).digest("hex");
  return {
    "x-codex-ingress-timestamp": String(timestamp),
    "x-codex-ingress-nonce": nonce,
    "x-codex-ingress-signature": signature
  };
}

describe("codex events api", () => {
  it("syncs task status and pushes notification to feishu", async () => {
    const messageBodies: string[] = [];
    const mockOpenApiServer = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => {
        raw += String(chunk);
      });
      request.on("end", () => {
        if (request.url === "/open-apis/auth/v3/tenant_access_token/internal") {
          response.statusCode = 200;
          response.setHeader("content-type", "application/json");
          response.end("{\"code\":0,\"tenant_access_token\":\"token-demo\",\"expire\":7200}");
          return;
        }

        if (request.url?.startsWith("/open-apis/im/v1/messages")) {
          messageBodies.push(raw);
          response.statusCode = 200;
          response.setHeader("content-type", "application/json");
          response.end("{\"code\":0}");
          return;
        }

        response.statusCode = 404;
        response.end();
      });
    });

    await new Promise<void>((resolve) => {
      mockOpenApiServer.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = mockOpenApiServer.address();
      if (!address || typeof address === "string") {
        throw new Error("Mock open api server address is invalid");
      }

      const db = createSqliteDatabase(":memory:");
      migrateDatabase(db);
      const sessions = new ToolSessionRepository(db);
      const tasks = new TaskRepository(db);
      const now = new Date("2026-04-26T10:20:00.000Z").toISOString();

      sessions.create({
        sessionId: "codex-session-001",
        toolProvider: "codex",
        toolSessionRef: "codex-runtime-001",
        status: "running",
        createdBy: "ou_target_user",
        createdAt: now,
        updatedAt: now
      });

      tasks.create({
        taskId: "task-codex-001",
        sessionId: "codex-session-001",
        triggerMessageId: null,
        taskType: "command",
        status: "running",
        summary: "initial summary",
        startedAt: now,
        finishedAt: null
      });

      const app = buildApp({
        db,
        env: {
          databasePath: ":memory:",
          logLevel: "silent",
          feishuOpenBaseUrl: `http://127.0.0.1:${address.port}`
        }
      });

      try {
        const currentConfig = await app.inject({
          method: "GET",
          url: "/api/connectors/feishu/config"
        });

        await app.inject({
          method: "PUT",
          url: "/api/connectors/feishu/config",
          payload: {
            ...(currentConfig.json() as Record<string, unknown>),
            enabled: true,
            appId: "app-id",
            appSecret: "app-secret",
            callbackUrl: "",
            templateTaskStarted: "任务开始",
            templateTaskSucceeded: "任务成功",
            templateTaskFailed: "任务失败",
            templateTaskPendingConfirm: "请确认"
          }
        });

        const response = await app.inject({
          method: "POST",
          url: "/api/codex/events",
          payload: {
            eventId: "codex-evt-001",
            taskId: "task-codex-001",
            sessionId: "codex-session-001",
            status: "succeeded",
            summary: "all checks passed",
            senderId: "codex_runner"
          }
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          accepted: true,
          duplicate: false,
          taskId: "task-codex-001",
          sessionId: "codex-session-001",
          status: "succeeded",
          notify: {
            sent: true,
            statusCode: 200
          }
        });

        const taskDetail = await app.inject({
          method: "GET",
          url: "/api/tasks/task-codex-001/detail"
        });

        expect(taskDetail.statusCode).toBe(200);
        expect(taskDetail.json().status).toBe("succeeded");
        expect(taskDetail.json().summary).toBe("all checks passed");

        const sessionDetail = await app.inject({
          method: "GET",
          url: "/api/sessions/codex-session-001/detail"
        });
        expect(sessionDetail.statusCode).toBe(200);
        expect(sessionDetail.json().status).toBe("closed");

        const duplicate = await app.inject({
          method: "POST",
          url: "/api/codex/events",
          payload: {
            eventId: "codex-evt-001",
            taskId: "task-codex-001",
            sessionId: "codex-session-001",
            status: "succeeded",
            summary: "all checks passed"
          }
        });

        expect(duplicate.statusCode).toBe(200);
        expect(duplicate.json()).toMatchObject({
          accepted: true,
          duplicate: true,
          eventId: "codex-evt-001"
        });
        expect(messageBodies).toHaveLength(1);
        expect(messageBodies[0]).toContain("任务成功");
        expect(messageBodies[0]).toContain("任务标题");
        expect(messageBodies[0]).toContain("完成内容");
        expect(messageBodies[0]).toContain("all checks passed");
      } finally {
        await app.close();
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        mockOpenApiServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it("creates task and session when codex event arrives first", async () => {
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
      method: "POST",
      url: "/api/codex/events",
      payload: {
        sessionId: "codex-first-session",
        status: "running",
        summary: "codex started with direct runtime event"
      }
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      accepted: boolean;
      duplicate: boolean;
      taskId: string;
      sessionId: string;
      status: string;
      notify: {
        sent: boolean;
        skipped: boolean;
      };
    };

    expect(payload.accepted).toBe(true);
    expect(payload.duplicate).toBe(false);
    expect(payload.sessionId).toBe("codex-first-session");
    expect(payload.status).toBe("running");
    expect(payload.notify.skipped).toBe(true);

    const sessionDetail = await app.inject({
      method: "GET",
      url: "/api/sessions/codex-first-session/detail"
    });
    expect(sessionDetail.statusCode).toBe(200);
    expect(sessionDetail.json().status).toBe("running");
    expect(sessionDetail.json().recentTasks[0].taskId).toBe(payload.taskId);

    await app.close();
  });

  it("creates a new task when explicit taskId does not exist", async () => {
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);
    const sessions = new ToolSessionRepository(db);
    const tasks = new TaskRepository(db);
    const now = new Date("2026-04-26T11:00:00.000Z").toISOString();

    sessions.create({
      sessionId: "codex-explicit-task-session",
      toolProvider: "codex",
      toolSessionRef: "runtime-keep",
      status: "running",
      createdBy: "ou_receiver_keep",
      createdAt: now,
      updatedAt: now
    });

    tasks.create({
      taskId: "existing-task-id",
      sessionId: "codex-explicit-task-session",
      triggerMessageId: null,
      taskType: "command",
      status: "running",
      summary: "existing running task",
      startedAt: now,
      finishedAt: null
    });

    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent"
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/codex/events",
      payload: {
        eventId: "codex-explicit-new-event",
        taskId: "new-task-id",
        sessionId: "codex-explicit-task-session",
        status: "succeeded",
        summary: "new completed task"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accepted: true,
      duplicate: false,
      taskId: "new-task-id",
      sessionId: "codex-explicit-task-session",
      status: "succeeded"
    });

    const newTask = await app.inject({
      method: "GET",
      url: "/api/tasks/new-task-id/detail"
    });
    expect(newTask.statusCode).toBe(200);
    expect(newTask.json().summary).toBe("new completed task");
    expect(newTask.json().status).toBe("succeeded");

    const oldTask = await app.inject({
      method: "GET",
      url: "/api/tasks/existing-task-id/detail"
    });
    expect(oldTask.statusCode).toBe(200);
    expect(oldTask.json().status).toBe("running");

    await app.close();
  });

  it("uses sender open_id as recipient when session is created by codex event", async () => {
    const messageBodies: string[] = [];
    const mockOpenApiServer = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => {
        raw += String(chunk);
      });
      request.on("end", () => {
        if (request.url === "/open-apis/auth/v3/tenant_access_token/internal") {
          response.statusCode = 200;
          response.setHeader("content-type", "application/json");
          response.end("{\"code\":0,\"tenant_access_token\":\"token-demo\",\"expire\":7200}");
          return;
        }

        if (request.url?.startsWith("/open-apis/im/v1/messages")) {
          messageBodies.push(raw);
          response.statusCode = 200;
          response.setHeader("content-type", "application/json");
          response.end("{\"code\":0}");
          return;
        }

        response.statusCode = 404;
        response.end();
      });
    });

    await new Promise<void>((resolve) => {
      mockOpenApiServer.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = mockOpenApiServer.address();
      if (!address || typeof address === "string") {
        throw new Error("Mock open api server address is invalid");
      }

      const db = createSqliteDatabase(":memory:");
      migrateDatabase(db);
      const app = buildApp({
        db,
        env: {
          databasePath: ":memory:",
          logLevel: "silent",
          feishuOpenBaseUrl: `http://127.0.0.1:${address.port}`
        }
      });

      try {
        const currentConfig = await app.inject({
          method: "GET",
          url: "/api/connectors/feishu/config"
        });

        await app.inject({
          method: "PUT",
          url: "/api/connectors/feishu/config",
          payload: {
            ...(currentConfig.json() as Record<string, unknown>),
            enabled: true,
            appId: "app-id",
            appSecret: "app-secret",
            callbackUrl: ""
          }
        });

        const response = await app.inject({
          method: "POST",
          url: "/api/codex/events",
          payload: {
            eventId: "codex-openid-event-1",
            taskId: "codex-openid-task-1",
            sessionId: "codex-openid-session-1",
            status: "succeeded",
            summary: "open_id routing verification",
            senderId: "ou_sender_for_notify"
          }
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          accepted: true,
          duplicate: false,
          notify: {
            sent: true,
            statusCode: 200
          }
        });

        const session = await app.inject({
          method: "GET",
          url: "/api/sessions/codex-openid-session-1/detail"
        });
        expect(session.statusCode).toBe(200);
        expect(session.json().createdBy).toBe("ou_sender_for_notify");

        expect(messageBodies).toHaveLength(1);
        expect(messageBodies[0]).toContain("\"receive_id\":\"ou_sender_for_notify\"");
      } finally {
        await app.close();
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        mockOpenApiServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it("validates codex ingress token when configured", async () => {
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        codexIngressToken: "codex-token-demo"
      }
    });

    const denied = await app.inject({
      method: "POST",
      url: "/api/codex/events",
      payload: {
        sessionId: "codex-auth-session",
        status: "running"
      }
    });

    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toEqual({
      code: "CODEX_TOKEN_INVALID",
      message: "Codex ingress token mismatch"
    });

    const allowed = await app.inject({
      method: "POST",
      url: "/api/codex/events",
      headers: {
        "x-codex-ingress-token": "codex-token-demo"
      },
      payload: {
        sessionId: "codex-auth-session",
        status: "running",
        summary: "authorized codex event"
      }
    });

    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      accepted: true,
      duplicate: false,
      sessionId: "codex-auth-session"
    });

    await app.close();
  });

  it("supports codex batch events and summarizes processing results", async () => {
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
      method: "POST",
      url: "/api/codex/events/batch",
      payload: {
        events: [
          {
            eventId: "codex-batch-evt-1",
            taskId: "codex-batch-task-1",
            sessionId: "codex-batch-session-1",
            status: "running",
            summary: "batch running"
          },
          {
            eventId: "codex-batch-evt-2",
            taskId: "codex-batch-task-1",
            sessionId: "codex-batch-session-1",
            status: "succeeded",
            summary: "batch succeeded"
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accepted: true,
      total: 2,
      processedCount: 2,
      duplicateCount: 0,
      failedCount: 0
    });

    const taskDetail = await app.inject({
      method: "GET",
      url: "/api/tasks/codex-batch-task-1/detail"
    });
    expect(taskDetail.statusCode).toBe(200);
    expect(taskDetail.json().status).toBe("succeeded");

    await app.close();
  });

  it("validates hmac signature and blocks replay when signing secret configured", async () => {
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        codexIngressSigningSecret: "codex-sign-secret",
        codexIngressMaxSkewSeconds: 300
      }
    });

    const payload = {
      eventId: "codex-sign-evt-1",
      taskId: "codex-sign-task-1",
      sessionId: "codex-sign-session-1",
      status: "running" as const
    };

    const denied = await app.inject({
      method: "POST",
      url: "/api/codex/events",
      payload
    });
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toEqual({
      code: "CODEX_SIGNATURE_MISSING",
      message: "Codex ingress signature headers are missing"
    });

    const timestamp = Math.floor(Date.now() / 1000);
    const headers = createSignedHeaders("codex-sign-secret", payload, timestamp, "nonce-a");
    const accepted = await app.inject({
      method: "POST",
      url: "/api/codex/events",
      headers,
      payload
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      accepted: true,
      duplicate: false,
      taskId: "codex-sign-task-1"
    });

    const replayed = await app.inject({
      method: "POST",
      url: "/api/codex/events",
      headers,
      payload
    });
    expect(replayed.statusCode).toBe(401);
    expect(replayed.json()).toEqual({
      code: "CODEX_SIGNATURE_REPLAYED",
      message: "Codex ingress signature replay detected"
    });

    await app.close();
  });
});
