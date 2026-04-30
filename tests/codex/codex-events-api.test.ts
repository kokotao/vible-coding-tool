import { createHmac } from "node:crypto";
import { buildApp } from "../../src/app";
import { TaskRepository } from "../../src/storage/repositories/task-repository";
import { ToolSessionRepository } from "../../src/storage/repositories/tool-session-repository";
import { createSqliteDatabase, migrateDatabase } from "../../src/storage/sqlite";
import { createFetchMock } from "../helpers/fetch-mock";

function createSignedHeaders(secret: string, payload: unknown, timestamp: number, nonce: string) {
  const rawBody = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${nonce}.${rawBody}`).digest("hex");
  return {
    "x-codex-ingress-timestamp": String(timestamp),
    "x-codex-ingress-nonce": nonce,
    "x-codex-ingress-signature": signature
  };
}

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

describe("codex events api", () => {
  it("syncs task status and pushes notification to feishu", async () => {
    const mockOpenApi = createFeishuOpenApiMock();

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
      fetchImpl: mockOpenApi.fetchImpl,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuOpenBaseUrl: "http://mock.feishu"
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

      const longDetail = `${"任务完成明细".repeat(80)}-DETAIL-END-MARKER`;
      const response = await app.inject({
        method: "POST",
        url: "/api/codex/events",
        payload: {
          eventId: "codex-evt-001",
          taskId: "task-codex-001",
          sessionId: "codex-session-001",
          status: "succeeded",
          summary: "all checks passed",
          detail: longDetail,
          senderId: "codex_runner",
          runtimeMeta: {
            durationMs: 125000,
            tokenUsage: 4876,
            modelSlug: "gpt-5.4",
            tokenUsageDetail: {
              inputTokens: 4000,
              cachedInputTokens: 500,
              outputTokens: 300,
              reasoningOutputTokens: 76,
              totalTokens: 4876
            },
            cumulativeTokenUsageDetail: {
              inputTokens: 4000,
              cachedInputTokens: 500,
              outputTokens: 300,
              reasoningOutputTokens: 76,
              totalTokens: 4876
            },
            lastTokenUsageDetail: {
              inputTokens: 900,
              cachedInputTokens: 120,
              outputTokens: 380,
              reasoningOutputTokens: 80,
              totalTokens: 1480
            }
          }
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
      expect(
        taskDetail.json().auditLogs.some(
          (item: { action: string; result: string }) =>
            item.action === "codex_notify_status" && item.result === "success"
        )
      ).toBe(true);

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
      expect(mockOpenApi.messageBodies).toHaveLength(1);
      const outboundPayload = JSON.parse(mockOpenApi.messageBodies[0]) as {
        receive_id: string;
        msg_type: string;
        content: string;
      };
      expect(outboundPayload.msg_type).toBe("interactive");
      expect(outboundPayload.content).toContain("任务成功");
      expect(outboundPayload.content).toContain("任务标题");
      expect(outboundPayload.content).toContain("完成内容");
      expect(outboundPayload.content).toContain("all checks passed");
      expect(outboundPayload.content).toContain("-DETAIL-END-MARKER");
      expect(outboundPayload.content).toContain("选择此会话");
      expect(outboundPayload.content).toContain("\"panelAction\":\"select_session\"");
      expect(outboundPayload.content).toContain("该次任务耗时");
      expect(outboundPayload.content).toContain("消耗 tokens");
      expect(outboundPayload.content).toContain("使用模型");
      expect(outboundPayload.content).toContain("gpt-5.4");
      expect(outboundPayload.content).toContain("累计明细");
      expect(outboundPayload.content).toContain("最近一次");
      expect(outboundPayload.content).toContain("缓存输入 500");
      expect(outboundPayload.content).toContain("推理输出 76");
      expect(outboundPayload.content).not.toContain("任务标题：");
      expect(outboundPayload.content).not.toContain("完成内容：");
      expect((outboundPayload.content.match(/任务状态：/g) || []).length).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("accepts nullable runtime meta and still renders the footer note", async () => {
    const mockOpenApi = createFeishuOpenApiMock();

    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);
    const sessions = new ToolSessionRepository(db);
    const tasks = new TaskRepository(db);
    const now = new Date("2026-04-26T10:20:00.000Z").toISOString();

    sessions.create({
      sessionId: "codex-session-null-meta",
      toolProvider: "codex",
      toolSessionRef: "codex-runtime-null-meta",
      status: "running",
      createdBy: "ou_target_user",
      createdAt: now,
      updatedAt: now
    });

    tasks.create({
      taskId: "task-codex-null-meta",
      sessionId: "codex-session-null-meta",
      triggerMessageId: null,
      taskType: "command",
      status: "running",
      summary: "initial summary",
      startedAt: now,
      finishedAt: null
    });

    const app = buildApp({
      db,
      fetchImpl: mockOpenApi.fetchImpl,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuOpenBaseUrl: "http://mock.feishu"
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
          eventId: "codex-evt-null-meta",
          taskId: "task-codex-null-meta",
          sessionId: "codex-session-null-meta",
          status: "succeeded",
          summary: "all checks passed",
          detail: "finished",
          senderId: "codex_runner",
          runtimeMeta: {
            durationMs: null,
            tokenUsage: null,
            modelSlug: null,
            tokenUsageDetail: null,
            lastTokenUsageDetail: null
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        accepted: true,
        duplicate: false
      });

      expect(mockOpenApi.messageBodies).toHaveLength(1);
      const outboundPayload = JSON.parse(mockOpenApi.messageBodies[0]) as {
        content: string;
      };
      expect(outboundPayload.content).toContain("该次任务耗时：--");
      expect(outboundPayload.content).toContain("消耗 tokens：--");
      expect(outboundPayload.content).toContain("使用模型：--");
    } finally {
      await app.close();
    }
  });

  it("deduplicates identical success notifications for the same task", async () => {
    const mockOpenApi = createFeishuOpenApiMock();

    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);
    const sessions = new ToolSessionRepository(db);
    const tasks = new TaskRepository(db);
    const now = new Date("2026-04-26T10:20:00.000Z").toISOString();

    sessions.create({
      sessionId: "codex-session-dup-001",
      toolProvider: "codex",
      toolSessionRef: "codex-runtime-dup-001",
      status: "running",
      createdBy: "ou_target_user",
      createdAt: now,
      updatedAt: now
    });

    tasks.create({
      taskId: "task-codex-dup-001",
      sessionId: "codex-session-dup-001",
      triggerMessageId: null,
      taskType: "command",
      status: "running",
      summary: "initial summary",
      startedAt: now,
      finishedAt: null
    });

    const app = buildApp({
      db,
      fetchImpl: mockOpenApi.fetchImpl,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuOpenBaseUrl: "http://mock.feishu"
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

      const first = await app.inject({
        method: "POST",
        url: "/api/codex/events",
        payload: {
          eventId: "codex-evt-dup-001",
          taskId: "task-codex-dup-001",
          sessionId: "codex-session-dup-001",
          status: "succeeded",
          summary: "all checks passed",
          senderId: "codex_runner"
        }
      });

      expect(first.statusCode).toBe(200);
      expect(mockOpenApi.messageBodies).toHaveLength(1);

      const second = await app.inject({
        method: "POST",
        url: "/api/codex/events",
        payload: {
          eventId: "codex-evt-dup-002",
          taskId: "task-codex-dup-001",
          sessionId: "codex-session-dup-001",
          status: "succeeded",
          summary: "all checks passed",
          senderId: "codex_runner"
        }
      });

      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({
        accepted: true,
        duplicate: true,
        taskId: "task-codex-dup-001",
        sessionId: "codex-session-dup-001",
        status: "succeeded",
        notify: {
          sent: false,
          skipped: true,
          reason: "duplicate_terminal_event"
        }
      });
      expect(mockOpenApi.messageBodies).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("aliases watcher synthetic task to active task and suppresses second completion push", async () => {
    const mockOpenApi = createFeishuOpenApiMock();

    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);
    const sessions = new ToolSessionRepository(db);
    const tasks = new TaskRepository(db);
    const now = new Date("2026-04-28T04:21:35.000Z").toISOString();

    sessions.create({
      sessionId: "codex-session-watch-001",
      toolProvider: "codex",
      toolSessionRef: "019dd16e-afbd-7cc3-82e2-b2a1eb053108",
      status: "running",
      createdBy: "ou_target_user",
      createdAt: now,
      updatedAt: now
    });

    tasks.create({
      taskId: "task-real-001",
      sessionId: "codex-session-watch-001",
      triggerMessageId: null,
      taskType: "command",
      status: "running",
      summary: "initial running summary",
      startedAt: now,
      finishedAt: null
    });

    const app = buildApp({
      db,
      fetchImpl: mockOpenApi.fetchImpl,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuOpenBaseUrl: "http://mock.feishu"
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

      const watcherFirst = await app.inject({
        method: "POST",
        url: "/api/codex/events",
        payload: {
          eventId: "codex-watch-complete-019dd16e-afbd-7cc3-82e2-b2a1eb053108-019dd252-3b38-7533-9fc4-d8264774d3e6",
          taskId: "codex-turn-019dd252-3b38-7533-9fc4-d8264774d3e6",
          sessionId: "codex-session-watch-001",
          toolSessionRef: "019dd16e-afbd-7cc3-82e2-b2a1eb053108",
          status: "succeeded",
          summary: "Codex任务完成：你好，在。要继续推进哪一步？",
          senderId: "ou_target_user"
        }
      });

      expect(watcherFirst.statusCode).toBe(200);
      expect(watcherFirst.json()).toMatchObject({
        accepted: true,
        duplicate: false,
        taskId: "task-real-001",
        sessionId: "codex-session-watch-001",
        status: "succeeded",
        notify: {
          sent: true,
          skipped: false
        }
      });

      const dispatcherSecond = await app.inject({
        method: "POST",
        url: "/api/codex/events",
        payload: {
          eventId: "codex-dispatch-close-evt-001",
          taskId: "task-real-001",
          sessionId: "codex-session-watch-001",
          toolSessionRef: "019dd16e-afbd-7cc3-82e2-b2a1eb053108",
          status: "succeeded",
          summary: "Codex任务完成：你好，在。要继续推进哪一步？",
          senderId: "codex_dispatcher"
        }
      });

      expect(dispatcherSecond.statusCode).toBe(200);
      expect(dispatcherSecond.json()).toMatchObject({
        accepted: true,
        duplicate: true,
        taskId: "task-real-001",
        sessionId: "codex-session-watch-001",
        status: "succeeded",
        notify: {
          sent: false,
          skipped: true,
          reason: "duplicate_terminal_event"
        }
      });

      expect(tasks.findByTaskId("codex-turn-019dd252-3b38-7533-9fc4-d8264774d3e6")).toBeUndefined();
      expect(mockOpenApi.messageBodies).toHaveLength(1);
    } finally {
      await app.close();
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
    const mockOpenApi = createFeishuOpenApiMock();

    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);
    const app = buildApp({
      db,
      fetchImpl: mockOpenApi.fetchImpl,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuOpenBaseUrl: "http://mock.feishu"
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

      expect(mockOpenApi.messageBodies).toHaveLength(1);
      expect(mockOpenApi.messageBodies[0]).toContain("\"receive_id\":\"ou_sender_for_notify\"");
    } finally {
      await app.close();
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
