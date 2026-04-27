import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCodexGlobalWatcher } from "../../src/modules/codex/codex-global-watcher";
import { createFetchMock } from "../helpers/fetch-mock";

describe("codex global watcher", () => {
  it("boots, tails new task_complete events, and can be stopped", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-watch-"));
    const sessionDir = join(tempDir, "sessions", "019dca61-0d90-7f01-b1b0-f1bb79eb955e");
    const rolloutPath = join(sessionDir, "rollout-019dca61-0d90-7f01-b1b0-f1bb79eb955e.jsonl");
    const statePath = join(tempDir, "state.json");
    const seenBodies: string[] = [];
    const { fetchImpl } = createFetchMock([
      {
        match: /\/health$/,
        response: () => new Response(JSON.stringify({ ok: true }), { status: 200 })
      },
      {
        match: /\/api\/feishu\/open-ids\/recent\?limit=1$/,
        response: () =>
          new Response(
            JSON.stringify({
              items: [
                {
                  openId: "ou_recent_sender",
                  sessionId: "feishu-codex-demo",
                  lastSeenAt: "2026-04-27T10:00:00.000Z",
                  messageCount: 3
                }
              ]
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json"
              }
            }
          )
      },
      {
        match: /\/api\/codex\/events$/,
        response: ({ bodyText }) => {
          seenBodies.push(bodyText);
          return new Response(JSON.stringify({ accepted: true }), {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          });
        }
      }
    ]);

    try {
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(rolloutPath, "", "utf8");

      const watcher = await startCodexGlobalWatcher({
        gatewayUrl: "http://mock.gateway",
        statePath,
        pollIntervalMs: 50,
        sessionId: "feishu-codex-test",
        senderId: "codex_global_watcher",
        recipientOpenId: null,
        sessionsRoot: join(tempDir, "sessions"),
        archivedSessionsRoot: join(tempDir, "archived_sessions"),
        scanArchived: false,
        bootstrapMode: "tail",
        fetchImpl
      });

      try {
        writeFileSync(
          rolloutPath,
          [
            JSON.stringify({
              type: "event_msg",
              timestamp: "2026-04-27T10:00:00.000Z",
              payload: {
                type: "task_complete",
                turn_id: "turn-001",
                last_agent_message: "完成了自动回推测试"
              }
            }),
            ""
          ].join("\n"),
          "utf8"
        );

        await new Promise<void>((resolve, reject) => {
          const startedAt = Date.now();
          const poll = () => {
            if (seenBodies.length > 0) {
              resolve();
              return;
            }

            if (Date.now() - startedAt > 3000) {
              reject(new Error("watcher did not post event in time"));
              return;
            }

            setTimeout(poll, 25);
          };

          poll();
        });

        expect(seenBodies).toHaveLength(1);
        const postedPayload = JSON.parse(seenBodies[0]) as { senderId?: string; taskId?: string; summary?: string };
        expect(postedPayload.senderId).toBe("ou_recent_sender");
        expect(postedPayload.taskId).toBe("codex-turn-turn-001");
        expect(seenBodies[0]).toContain("Codex任务完成");
        expect(seenBodies[0]).toContain("完成了自动回推测试");
      } finally {
        await watcher.stop();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not replay historical task_complete events on first boot in tail mode", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codex-watch-tail-"));
    const sessionDir = join(tempDir, "sessions", "019dca61-0d90-7f01-b1b0-f1bb79eb955e");
    const rolloutPath = join(sessionDir, "rollout-019dca61-0d90-7f01-b1b0-f1bb79eb955e.jsonl");
    const statePath = join(tempDir, "state.json");
    const seenBodies: string[] = [];
    const { fetchImpl } = createFetchMock([
      {
        match: /\/health$/,
        response: () => new Response(JSON.stringify({ ok: true }), { status: 200 })
      },
      {
        match: /\/api\/feishu\/open-ids\/recent\?limit=1$/,
        response: () => new Response(JSON.stringify({ items: [] }), { status: 200 })
      },
      {
        match: /\/api\/codex\/events$/,
        response: ({ bodyText }) => {
          seenBodies.push(bodyText);
          return new Response(JSON.stringify({ accepted: true }), {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          });
        }
      }
    ]);

    try {
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        rolloutPath,
        [
          JSON.stringify({
            type: "event_msg",
            timestamp: "2026-04-27T10:00:00.000Z",
            payload: {
              type: "task_complete",
              turn_id: "turn-history",
              last_agent_message: "这是历史完成消息，不应在首次tail启动时补发"
            }
          }),
          ""
        ].join("\n"),
        "utf8"
      );

      const watcher = await startCodexGlobalWatcher({
        gatewayUrl: "http://mock.gateway",
        statePath,
        pollIntervalMs: 50,
        sessionId: "feishu-codex-test",
        senderId: "codex_global_watcher",
        recipientOpenId: null,
        sessionsRoot: join(tempDir, "sessions"),
        archivedSessionsRoot: join(tempDir, "archived_sessions"),
        scanArchived: false,
        bootstrapMode: "tail",
        fetchImpl
      });

      try {
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(seenBodies).toHaveLength(0);

        writeFileSync(
          rolloutPath,
          [
            JSON.stringify({
              type: "event_msg",
              timestamp: "2026-04-27T10:00:00.000Z",
              payload: {
                type: "task_complete",
                turn_id: "turn-history",
                last_agent_message: "这是历史完成消息，不应在首次tail启动时补发"
              }
            }),
            JSON.stringify({
              type: "event_msg",
              timestamp: "2026-04-27T10:00:05.000Z",
              payload: {
                type: "task_complete",
                turn_id: "turn-new",
                last_agent_message: "这是启动后新增完成消息，应该被推送"
              }
            }),
            ""
          ].join("\n"),
          "utf8"
        );

        await new Promise<void>((resolve, reject) => {
          const startedAt = Date.now();
          const poll = () => {
            if (seenBodies.length > 0) {
              resolve();
              return;
            }

            if (Date.now() - startedAt > 3000) {
              reject(new Error("watcher did not post new event in time"));
              return;
            }

            setTimeout(poll, 25);
          };

          poll();
        });

        expect(seenBodies).toHaveLength(1);
        expect(seenBodies[0]).toContain("codex-turn-turn-new");
      } finally {
        await watcher.stop();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
