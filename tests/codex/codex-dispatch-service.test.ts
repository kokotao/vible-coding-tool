/**
 * @description Codex 调度器回归测试，确保 close 事件回灌完整 runtimeMeta
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-28 17:50
 */
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexDispatchService } from "../../src/modules/codex/codex-dispatch-service";

vi.mock("node:child_process", () => ({
  spawn: vi.fn()
}));

describe("codex dispatch service", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses selected project path as cwd when dispatching a fresh session", () => {
    const mockedSpawn = vi.mocked(spawn);
    const tempProjectDir = mkdtempSync(join(tmpdir(), "codex-dispatch-cwd-"));
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      unref: vi.fn()
    });
    mockedSpawn.mockReturnValue(child as never);

    try {
      const service = new CodexDispatchService(
        {
          codexEventService: {
            handleEvent: vi.fn(async () => ({ accepted: true }))
          } as never,
          auditLogRepository: {
            create: vi.fn()
          } as never,
          toolSessionRepository: {
            findBySessionId: () => null
          } as never,
          codexCliRuntimeService: {
            prepareDispatchContext: () => ({
              ready: true,
              codexBin: "codex",
              env: {},
              extraArgs: [],
              authorization: {
                trustedInConfig: true,
                trustUpdated: false,
                warning: null
              }
            })
          } as never
        },
        {
          enabled: true,
          codexBin: "codex",
          skipGitRepoCheck: false
        }
      );

      const result = service.dispatchTask({
        taskId: "task-cwd-001",
        sessionId: "session-cwd-001",
        prompt: "hello from project",
        actorId: "ou_test",
        projectPath: tempProjectDir
      });

      expect(result.accepted).toBe(true);
      expect(mockedSpawn).toHaveBeenCalledWith(
        "codex",
        expect.any(Array),
        expect.objectContaining({
          cwd: tempProjectDir
        })
      );
    } finally {
      rmSync(tempProjectDir, { recursive: true, force: true });
    }
  });

  it("preserves detailed runtime meta when codex closes", async () => {
    const handleEvent = vi.fn(async () => ({ accepted: true }));
    const auditCreate = vi.fn();
    const mockedSpawn = vi.mocked(spawn);

    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      unref: vi.fn()
    });
    mockedSpawn.mockReturnValue(child as never);

    const service = new CodexDispatchService(
      {
        codexEventService: {
          handleEvent
        } as never,
        auditLogRepository: {
          create: auditCreate
        } as never,
        toolSessionRepository: {
          findBySessionId: () => null
        } as never,
        codexCliRuntimeService: {
          prepareDispatchContext: () => ({
            ready: true,
            codexBin: "codex",
            env: {},
            extraArgs: [],
            authorization: {
              trustedInConfig: true,
              trustUpdated: false,
              warning: null
            }
          })
        } as never
      },
      {
        enabled: true,
        codexBin: "codex",
        skipGitRepoCheck: false
      }
    );

    const result = service.dispatchTask({
      taskId: "task-001",
      sessionId: "session-001",
      prompt: "hello",
      actorId: "ou_test",
      modelSlug: "gpt-5.4"
    });

    expect(result.accepted).toBe(true);

    (child.stdout as EventEmitter).emit(
      "data",
      Buffer.from(
        [
          JSON.stringify({
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 20,
                output_tokens: 30,
                reasoning_output_tokens: 5,
                total_tokens: 130
              },
              last_token_usage: {
                input_tokens: 10,
                cached_input_tokens: 2,
                output_tokens: 3,
                reasoning_output_tokens: 1,
                total_tokens: 13
              }
            }
          }),
          JSON.stringify({
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "done"
            }
          })
        ].join("\n")
      )
    );

    child.emit("close", 0);

    await waitFor(() => expect(handleEvent).toHaveBeenCalled());

    const calls = handleEvent.mock.calls as unknown as Array<[unknown]>;
    const firstCall = calls[0];
    expect(firstCall).toBeDefined();

    const payload = firstCall![0] as {
      runtimeMeta?: {
        durationMs?: number | null;
        tokenUsage?: number | null;
        modelSlug?: string | null;
        tokenUsageDetail?: {
          inputTokens?: number | null;
          cachedInputTokens?: number | null;
          outputTokens?: number | null;
          reasoningOutputTokens?: number | null;
          totalTokens?: number | null;
        } | null;
        lastTokenUsageDetail?: {
          inputTokens?: number | null;
          cachedInputTokens?: number | null;
          outputTokens?: number | null;
          reasoningOutputTokens?: number | null;
          totalTokens?: number | null;
        } | null;
      } | null;
    };

    expect(payload.runtimeMeta).toMatchObject({
      tokenUsage: 130,
      modelSlug: "gpt-5.4",
      tokenUsageDetail: {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 30,
        reasoningOutputTokens: 5,
        totalTokens: 130
      },
      lastTokenUsageDetail: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 3,
        reasoningOutputTokens: 1,
        totalTokens: 13
      }
    });
  });

  it("wraps codex spawn with cmd.exe on windows when resolved command is cmd shim", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const mockedSpawn = vi.mocked(spawn);
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      unref: vi.fn()
    });
    mockedSpawn.mockReturnValue(child as never);

    try {
      const service = new CodexDispatchService(
        {
          codexEventService: {
            handleEvent: vi.fn(async () => ({ accepted: true }))
          } as never,
          auditLogRepository: {
            create: vi.fn()
          } as never,
          toolSessionRepository: {
            findBySessionId: () => null
          } as never,
          codexCliRuntimeService: {
            prepareDispatchContext: () => ({
              ready: true,
              codexBin: "C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd",
              env: {},
              extraArgs: [],
              authorization: {
                trustedInConfig: true,
                trustUpdated: false,
                warning: null
              }
            })
          } as never
        },
        {
          enabled: true,
          codexBin: "codex",
          skipGitRepoCheck: false
        }
      );

      const result = service.dispatchTask({
        taskId: "task-win-001",
        sessionId: "session-win-001",
        prompt: "windows probe",
        actorId: "ou_test"
      });

      expect(result.accepted).toBe(true);
      expect(mockedSpawn).toHaveBeenCalledWith(
        "cmd.exe",
        expect.arrayContaining(["/d", "/s", "/c"]),
        expect.objectContaining({
          detached: true,
          windowsHide: true
        })
      );
      const spawnArgs = mockedSpawn.mock.calls[0]?.[1] as string[];
      expect(spawnArgs[3]).toContain('"C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd"');
      expect(spawnArgs[3]).toContain('"exec"');
    } finally {
      platformSpy.mockRestore();
    }
  });
});

async function waitFor(assertion: () => void, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - startedAt > timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
