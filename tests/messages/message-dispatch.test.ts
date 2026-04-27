import { MessageRepository } from "../../src/storage/repositories/message-repository";
import { TaskRepository } from "../../src/storage/repositories/task-repository";
import { createSqliteDatabase, migrateDatabase } from "../../src/storage/sqlite";

describe("sqlite repositories", () => {
  it("persists a task and message", () => {
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const tasks = new TaskRepository(db);
    const messages = new MessageRepository(db);

    const now = new Date().toISOString();
    const task = tasks.create({
      taskId: "task-1",
      sessionId: "sess_001",
      triggerMessageId: null,
      taskType: "command",
      status: "pending",
      summary: null,
      startedAt: now,
      finishedAt: null
    });

    messages.create({
      eventId: "evt-1",
      sessionId: "sess_001",
      direction: "bot_to_tool",
      sourcePlatform: "feishu",
      platformMessageId: null,
      senderId: "user-1",
      content: "run task",
      messageType: "command",
      riskLevel: "low",
      status: "received",
      taskId: task?.taskId ?? null,
      createdAt: now
    });

    expect(task?.sessionId).toBe("sess_001");
    expect(tasks.findByTaskId("task-1")?.sessionId).toBe("sess_001");
    expect(messages.findByEventId("evt-1")?.taskId).toBe("task-1");

    db.close();
  });
});
