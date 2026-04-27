import { buildApp } from "../../src/app";
import { AuditLogRepository } from "../../src/storage/repositories/audit-log-repository";
import { MessageRepository } from "../../src/storage/repositories/message-repository";
import { TaskRepository } from "../../src/storage/repositories/task-repository";
import { ToolSessionRepository } from "../../src/storage/repositories/tool-session-repository";
import { createSqliteDatabase, migrateDatabase } from "../../src/storage/sqlite";

function seedCodexQueryData() {
  const db = createSqliteDatabase(":memory:");
  migrateDatabase(db);

  const sessions = new ToolSessionRepository(db);
  const tasks = new TaskRepository(db);
  const messages = new MessageRepository(db);
  const audits = new AuditLogRepository(db);

  const t1 = new Date("2026-04-26T02:30:00.000Z").toISOString();
  const t2 = new Date("2026-04-26T02:31:00.000Z").toISOString();
  const t3 = new Date("2026-04-26T02:32:00.000Z").toISOString();
  const t4 = new Date("2026-04-26T02:33:00.000Z").toISOString();

  sessions.create({
    sessionId: "codex-sess-running",
    toolProvider: "codex",
    toolSessionRef: "codex-ref-running",
    status: "running",
    createdBy: "ou_user_1",
    createdAt: t1,
    updatedAt: t4
  });

  sessions.create({
    sessionId: "codex-sess-closed",
    toolProvider: "codex",
    toolSessionRef: "codex-ref-closed",
    status: "closed",
    createdBy: "ou_user_2",
    createdAt: t1,
    updatedAt: t3
  });

  sessions.create({
    sessionId: "claude-sess-running",
    toolProvider: "claude",
    toolSessionRef: "claude-ref-running",
    status: "running",
    createdBy: "ou_user_3",
    createdAt: t1,
    updatedAt: t4
  });

  tasks.create({
    taskId: "codex-task-running",
    sessionId: "codex-sess-running",
    triggerMessageId: "msg-1",
    taskType: "command",
    status: "running",
    summary: "running summary",
    startedAt: t2,
    finishedAt: null
  });

  tasks.create({
    taskId: "codex-task-failed",
    sessionId: "codex-sess-running",
    triggerMessageId: "msg-2",
    taskType: "command",
    status: "failed",
    summary: "failed summary",
    startedAt: t1,
    finishedAt: t3
  });

  tasks.create({
    taskId: "codex-task-succeeded",
    sessionId: "codex-sess-closed",
    triggerMessageId: "msg-3",
    taskType: "command",
    status: "succeeded",
    summary: "succeeded summary",
    startedAt: t2,
    finishedAt: t4
  });

  tasks.create({
    taskId: "claude-task-running",
    sessionId: "claude-sess-running",
    triggerMessageId: "msg-4",
    taskType: "command",
    status: "running",
    summary: "claude running summary",
    startedAt: t2,
    finishedAt: null
  });

  messages.create({
    eventId: "msg-1",
    sessionId: "codex-sess-running",
    direction: "bot_to_tool",
    sourcePlatform: "feishu",
    platformMessageId: null,
    senderId: "ou_user_1",
    content: "run codex task",
    messageType: "command",
    riskLevel: "low",
    status: "running",
    taskId: "codex-task-running",
    createdAt: t2
  });

  messages.create({
    eventId: "msg-3",
    sessionId: "codex-sess-closed",
    direction: "tool_to_bot",
    sourcePlatform: "codex",
    platformMessageId: null,
    senderId: "codex_runner",
    content: "task succeeded",
    messageType: "tool_event",
    riskLevel: "low",
    status: "succeeded",
    taskId: "codex-task-succeeded",
    createdAt: t4
  });

  messages.create({
    eventId: "msg-4",
    sessionId: "claude-sess-running",
    direction: "tool_to_bot",
    sourcePlatform: "claude",
    platformMessageId: null,
    senderId: "claude_runner",
    content: "claude task running",
    messageType: "tool_event",
    riskLevel: "low",
    status: "running",
    taskId: "claude-task-running",
    createdAt: t4
  });

  audits.create({
    eventId: "audit-codex-1",
    taskId: "codex-task-running",
    sessionId: "codex-sess-running",
    action: "codex_event_sync",
    actorId: "codex_runner",
    result: "success",
    detail: "running update synced",
    createdAt: t4
  });

  return db;
}

describe("codex query api", () => {
  it("lists codex sessions and supports status filter", async () => {
    const db = seedCodexQueryData();
    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent"
      }
    });

    const allResponse = await app.inject({
      method: "GET",
      url: "/api/codex/sessions?limit=10"
    });

    expect(allResponse.statusCode).toBe(200);
    const allPayload = allResponse.json() as {
      items: Array<{ sessionId: string; status: string }>;
    };
    expect(allPayload.items).toHaveLength(2);
    expect(allPayload.items.map((item) => item.sessionId)).toEqual(
      expect.arrayContaining(["codex-sess-running", "codex-sess-closed"])
    );

    const runningResponse = await app.inject({
      method: "GET",
      url: "/api/codex/sessions?statuses=running"
    });
    expect(runningResponse.statusCode).toBe(200);
    const runningPayload = runningResponse.json() as {
      items: Array<{ sessionId: string; status: string }>;
    };
    expect(runningPayload.items).toHaveLength(1);
    expect(runningPayload.items[0]).toMatchObject({
      sessionId: "codex-sess-running",
      status: "running"
    });

    await app.close();
  });

  it("lists codex tasks and excludes non-codex provider tasks", async () => {
    const db = seedCodexQueryData();
    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent"
      }
    });

    const activeResponse = await app.inject({
      method: "GET",
      url: "/api/codex/tasks/active?limit=10"
    });
    expect(activeResponse.statusCode).toBe(200);
    const activePayload = activeResponse.json() as {
      items: Array<{ taskId: string; status: string }>;
    };
    expect(activePayload.items).toHaveLength(1);
    expect(activePayload.items[0]).toMatchObject({
      taskId: "codex-task-running",
      status: "running"
    });

    const finishedResponse = await app.inject({
      method: "GET",
      url: "/api/codex/tasks?statuses=succeeded,failed&limit=10"
    });
    expect(finishedResponse.statusCode).toBe(200);
    const finishedPayload = finishedResponse.json() as {
      items: Array<{ taskId: string; status: string }>;
    };
    expect(finishedPayload.items).toHaveLength(2);
    expect(finishedPayload.items.map((item) => item.taskId)).toEqual(
      expect.arrayContaining(["codex-task-failed", "codex-task-succeeded"])
    );

    await app.close();
  });

  it("returns codex overview summary and task events", async () => {
    const db = seedCodexQueryData();
    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent"
      }
    });

    const overviewResponse = await app.inject({
      method: "GET",
      url: "/api/codex/overview?taskLimit=5&sessionLimit=5"
    });
    expect(overviewResponse.statusCode).toBe(200);
    const overviewPayload = overviewResponse.json() as {
      summary: {
        runningTaskCount: number;
        succeededTaskCount: number;
        failedTaskCount: number;
        activeSessionCount: number;
        closedSessionCount: number;
      };
      activeTasks: Array<{ taskId: string; status: string }>;
      recentSessions: Array<{ sessionId: string }>;
      sinceHours: number | null;
      sinceAt: string | null;
    };
    expect(overviewPayload.summary).toMatchObject({
      runningTaskCount: 1,
      succeededTaskCount: 1,
      failedTaskCount: 1,
      activeSessionCount: 1,
      closedSessionCount: 1
    });
    expect(overviewPayload.sinceHours).toBeNull();
    expect(overviewPayload.activeTasks).toHaveLength(1);
    expect(overviewPayload.activeTasks[0].taskId).toBe("codex-task-running");
    expect(overviewPayload.recentSessions).toHaveLength(2);

    const windowedResponse = await app.inject({
      method: "GET",
      url: "/api/codex/overview?sinceHours=1&taskLimit=5&sessionLimit=5"
    });
    expect(windowedResponse.statusCode).toBe(200);
    const windowedPayload = windowedResponse.json() as {
      summary: {
        runningTaskCount: number;
        succeededTaskCount: number;
        failedTaskCount: number;
        activeSessionCount: number;
        closedSessionCount: number;
      };
      activeTasks: Array<{ taskId: string; status: string }>;
      recentSessions: Array<{ sessionId: string }>;
      sinceHours: number | null;
      sinceAt: string | null;
    };
    expect(windowedPayload.sinceHours).toBe(1);
    expect(windowedPayload.sinceAt).not.toBeNull();
    expect(windowedPayload.summary).toMatchObject({
      runningTaskCount: 0,
      succeededTaskCount: 0,
      failedTaskCount: 0,
      activeSessionCount: 0,
      closedSessionCount: 0
    });
    expect(windowedPayload.activeTasks).toHaveLength(0);
    expect(windowedPayload.recentSessions).toHaveLength(0);

    const eventsResponse = await app.inject({
      method: "GET",
      url: "/api/codex/tasks/codex-task-running/events?limit=20"
    });
    expect(eventsResponse.statusCode).toBe(200);
    const eventsPayload = eventsResponse.json() as {
      taskId: string;
      status: string;
      items: Array<{ type: string; event: string }>;
    };
    expect(eventsPayload.taskId).toBe("codex-task-running");
    expect(eventsPayload.status).toBe("running");
    expect(eventsPayload.items.some((item) => item.type === "task_status")).toBe(true);
    expect(eventsPayload.items.some((item) => item.type === "message")).toBe(true);
    expect(eventsPayload.items.some((item) => item.type === "audit")).toBe(true);

    await app.close();
  });
});
