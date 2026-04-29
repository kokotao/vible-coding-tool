import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/app";
import { createSqliteDatabase, migrateDatabase } from "../../src/storage/sqlite";

describe("codex local sessions api", () => {
  it("scans rollout files, groups them by project and exposes parsed chat content", async () => {
    const sessionsRoot = mkdtempSync(join(tmpdir(), "codex-local-sessions-"));
    const dayPath1 = join(sessionsRoot, "2026", "04", "26");
    const dayPath2 = join(sessionsRoot, "2026", "04", "27");
    mkdirSync(dayPath1, { recursive: true });
    mkdirSync(dayPath2, { recursive: true });

    const threadId1 = "019dca59-78b8-7d10-88fd-b6f9b8a7c409";
    const threadId2 = "019dca61-1382-75d3-9d93-d743ff4e7017";
    const rollout1 = `rollout-2026-04-26T23-12-34-${threadId1}.jsonl`;
    const rollout2 = `rollout-2026-04-27T08-00-00-${threadId2}.jsonl`;

    writeFileSync(
      join(dayPath1, rollout1),
      [
        JSON.stringify({
          timestamp: "2026-04-26T23:12:34.000Z",
          type: "session_meta",
          payload: {
            id: threadId1,
            timestamp: "2026-04-26T23:12:34.000Z",
            cwd: "/Users/albertluo/workSpace/albertLuo/vible-coding-Tool",
            originator: "Codex Desktop"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-26T23:12:35.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: "我希望本地会话目录可以单独写一页"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-26T23:12:35.500Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: "左侧按日期跳转并加载会话内容"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-26T23:12:36.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "shell",
            arguments: {
              command: "rg --files"
            }
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-26T23:12:37.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-001",
            output: "src/app.ts"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-26T23:12:37.500Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: "第三条用户消息作为标题"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-26T23:12:38.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: "我们可以先拆成独立页面，再优化目录布局。"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-26T23:12:39.000Z",
          type: "event_msg",
          message: "noise",
          payload: {
            type: "task_started"
          }
        }),
        ""
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      join(dayPath2, rollout2),
      [
        JSON.stringify({
          timestamp: "2026-04-27T08:00:00.000Z",
          type: "session_meta",
          payload: {
            id: threadId2,
            timestamp: "2026-04-27T08:00:00.000Z",
            cwd: "/Users/albertluo/workSpace/albertLuo/text-editor",
            originator: "Codex Desktop"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-27T08:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: "优化 UI 显示和布局设计"
          }
        }),
        JSON.stringify({
          timestamp: "2026-04-27T08:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: "好的，我们把目录页做成三栏工作台。"
          }
        }),
        ""
      ].join("\n"),
      "utf8"
    );

    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        codexLocalSessionsScanEnabled: true,
        codexLocalSessionsRoot: sessionsRoot,
        codexLocalSessionsScanIntervalMs: 1000
      }
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/codex/local-sessions?limit=20&refresh=true"
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json() as {
        rootPath: string;
        totalFiles: number;
        totalThreads: number;
        items: Array<{
          threadId: string;
          rolloutFileName: string;
          projectName: string;
          sessionTitle: string;
          year: string;
          month: string;
          day: string;
        }>;
        groups: Array<{
          year: string;
          count: number;
          months: Array<{
            month: string;
            count: number;
            days: Array<{ day: string; count: number }>;
          }>;
        }>;
      };

      expect(payload.rootPath).toBe(sessionsRoot);
      expect(payload.totalFiles).toBe(2);
      expect(payload.totalThreads).toBe(2);
      expect(payload.items.map((item) => item.threadId)).toEqual(expect.arrayContaining([threadId1, threadId2]));
      expect(payload.items.map((item) => item.rolloutFileName)).toEqual(expect.arrayContaining([rollout1, rollout2]));
      expect(payload.items.map((item) => item.projectName)).toEqual(
        expect.arrayContaining(["vible-coding-Tool", "text-editor"])
      );
      const sessionOne = payload.items.find((item) => item.threadId === threadId1);
      expect(sessionOne?.sessionTitle).toContain("第三条用户消息作为标题");
      expect(payload.groups[0].year).toBe("2026");
      expect(payload.groups[0].months[0].month).toBe("04");
      expect(payload.groups[0].months[0].days.map((day) => day.day)).toEqual(expect.arrayContaining(["26", "27"]));

      const detailResponse = await app.inject({
        method: "GET",
        url: `/api/codex/local-sessions/${threadId1}?refresh=true`
      });

      expect(detailResponse.statusCode).toBe(200);
      const detail = detailResponse.json() as {
        threadId: string;
        projectName: string;
        sessionTitle: string;
        messages: Array<{ kind: string; role: string; content: string }>;
      };

      expect(detail.threadId).toBe(threadId1);
      expect(detail.projectName).toBe("vible-coding-Tool");
      expect(detail.sessionTitle).toContain("第三条用户消息作为标题");
      expect(detail.messages).toHaveLength(6);
      expect(detail.messages.map((message) => message.kind)).toEqual(
        expect.arrayContaining(["message", "tool_call", "tool_output"])
      );
      expect(detail.messages.some((message) => message.content === "noise")).toBe(false);
    } finally {
      await app.close();
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it("returns 503 when local scanner is disabled", async () => {
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        codexLocalSessionsScanEnabled: false
      }
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/codex/local-sessions"
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        code: "CODEX_LOCAL_SESSIONS_DISABLED",
        message: "Local codex sessions scanner is disabled"
      });
    } finally {
      await app.close();
    }
  });

  it("resolves ~/.codex path on Windows-style USERPROFILE and falls back to ~/.codex when sessions folder is missing", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "codex-win-home-"));
    const codexRoot = join(fakeHome, ".codex");
    const dayPath = join(codexRoot, "2026", "04", "28");
    mkdirSync(dayPath, { recursive: true });

    const threadId = "019dca99-1382-75d3-9d93-d743ff4e7999";
    writeFileSync(
      join(dayPath, `rollout-2026-04-28T08-00-00-${threadId}.jsonl`),
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: threadId,
            timestamp: "2026-04-28T08:00:00.000Z",
            cwd: "C:\\Users\\demo\\workSpace\\project-win"
          }
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: "windows path scan smoke test"
          }
        }),
        ""
      ].join("\n"),
      "utf8"
    );

    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = "";
    process.env.USERPROFILE = fakeHome;

    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);
    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        codexLocalSessionsScanEnabled: true,
        codexLocalSessionsRoot: "~/.codex/sessions",
        codexLocalSessionsScanIntervalMs: 1000
      }
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/codex/local-sessions?limit=20&refresh=true"
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json() as {
        rootPath: string;
        totalFiles: number;
        items: Array<{ threadId: string }>;
      };
      expect(payload.rootPath).toBe(codexRoot);
      expect(payload.totalFiles).toBe(1);
      expect(payload.items[0]?.threadId).toBe(threadId);
    } finally {
      await app.close();
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
