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
    vi.restoreAllMocks();
  });

  it("uses selected project path as cwd when dispatching a fresh session", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
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
      platformSpy.mockRestore();
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
      tokenUsage: 13,
      modelSlug: "gpt-5.4",
      tokenUsageDetail: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 3,
        reasoningOutputTokens: 1,
        totalTokens: 13
      },
      cumulativeTokenUsageDetail: {
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

  it("parses token_count across stdout chunk boundaries", async () => {
    const handleEvent = vi.fn(async () => ({ accepted: true }));
    const mockedSpawn = vi.mocked(spawn);

    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: {
        write: vi.fn(),
        end: vi.fn()
      },
      unref: vi.fn()
    });
    mockedSpawn.mockReturnValue(child as never);

    const service = new CodexDispatchService(
      {
        codexEventService: {
          handleEvent
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
      taskId: "task-split-001",
      sessionId: "session-split-001",
      prompt: "hello split",
      actorId: "ou_test",
      modelSlug: "gpt-5.4-mini"
    });
    expect(result.accepted).toBe(true);

    const tokenCountLine = JSON.stringify({
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 200,
          cached_input_tokens: 40,
          output_tokens: 60,
          reasoning_output_tokens: 10,
          total_tokens: 260
        }
      }
    });
    const splitAt = Math.floor(tokenCountLine.length / 2);
    (child.stdout as EventEmitter).emit("data", Buffer.from(tokenCountLine.slice(0, splitAt)));
    (child.stdout as EventEmitter).emit("data", Buffer.from(`${tokenCountLine.slice(splitAt)}\n`));
    child.emit("close", 0);

    await waitFor(() => expect(handleEvent).toHaveBeenCalled());
    const payload = firstEventPayload(handleEvent);
    expect(payload.runtimeMeta).toMatchObject({
      tokenUsage: 260,
      modelSlug: "gpt-5.4-mini"
    });
  });

  it("keeps token usage when token_count scrolls out of tail output", async () => {
    const handleEvent = vi.fn(async () => ({ accepted: true }));
    const mockedSpawn = vi.mocked(spawn);

    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: {
        write: vi.fn(),
        end: vi.fn()
      },
      unref: vi.fn()
    });
    mockedSpawn.mockReturnValue(child as never);

    const service = new CodexDispatchService(
      {
        codexEventService: {
          handleEvent
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
      taskId: "task-tail-001",
      sessionId: "session-tail-001",
      prompt: "hello tail",
      actorId: "ou_test",
      modelSlug: "gpt-5.4-mini"
    });
    expect(result.accepted).toBe(true);

    const tokenCountLine = JSON.stringify({
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 11,
          cached_input_tokens: 2,
          output_tokens: 3,
          reasoning_output_tokens: 1,
          total_tokens: 14
        }
      }
    });
    (child.stdout as EventEmitter).emit("data", Buffer.from(`${tokenCountLine}\n`));
    (child.stdout as EventEmitter).emit("data", Buffer.from("x".repeat(40_000)));
    child.emit("close", 0);

    await waitFor(() => expect(handleEvent).toHaveBeenCalled());
    const payload = firstEventPayload(handleEvent);
    expect(payload.runtimeMeta).toMatchObject({
      tokenUsage: 14,
      modelSlug: "gpt-5.4-mini"
    });
  });

  it("parses token_count wrapped in event_msg payload", async () => {
    const handleEvent = vi.fn(async () => ({ accepted: true }));
    const mockedSpawn = vi.mocked(spawn);

    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: {
        write: vi.fn(),
        end: vi.fn()
      },
      unref: vi.fn()
    });
    mockedSpawn.mockReturnValue(child as never);

    const service = new CodexDispatchService(
      {
        codexEventService: {
          handleEvent
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
      taskId: "task-event-msg-001",
      sessionId: "session-event-msg-001",
      prompt: "hello wrapped token",
      actorId: "ou_test",
      modelSlug: "gpt-5.3-codex"
    });
    expect(result.accepted).toBe(true);

    const wrappedTokenLine = JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 33,
            cached_input_tokens: 4,
            output_tokens: 7,
            reasoning_output_tokens: 2,
            total_tokens: 40
          }
        }
      }
    });
    (child.stdout as EventEmitter).emit("data", Buffer.from(`${wrappedTokenLine}\n`));
    child.emit("close", 0);

    await waitFor(() => expect(handleEvent).toHaveBeenCalled());
    const payload = firstEventPayload(handleEvent);
    expect(payload.runtimeMeta).toMatchObject({
      tokenUsage: 40,
      modelSlug: "gpt-5.3-codex"
    });
  });

  it("parses usage from turn.completed output", async () => {
    const handleEvent = vi.fn(async () => ({ accepted: true }));
    const mockedSpawn = vi.mocked(spawn);

    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: {
        write: vi.fn(),
        end: vi.fn()
      },
      unref: vi.fn()
    });
    mockedSpawn.mockReturnValue(child as never);

    const service = new CodexDispatchService(
      {
        codexEventService: {
          handleEvent
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
      taskId: "task-turn-completed-001",
      sessionId: "session-turn-completed-001",
      prompt: "hello turn completed",
      actorId: "ou_test",
      modelSlug: "gpt-5.3-codex"
    });
    expect(result.accepted).toBe(true);

    const turnCompletedLine = JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 10357,
        cached_input_tokens: 8576,
        output_tokens: 17,
        reasoning_output_tokens: 0
      }
    });
    (child.stdout as EventEmitter).emit("data", Buffer.from(`${turnCompletedLine}\n`));
    child.emit("close", 0);

    await waitFor(() => expect(handleEvent).toHaveBeenCalled());
    const payload = firstEventPayload(handleEvent);
    expect(payload.runtimeMeta).toMatchObject({
      tokenUsage: 10374,
      modelSlug: "gpt-5.3-codex",
      tokenUsageDetail: {
        inputTokens: 10357,
        cachedInputTokens: 8576,
        outputTokens: 17,
        reasoningOutputTokens: 0,
        totalTokens: 10374
      },
      lastTokenUsageDetail: {
        inputTokens: 10357,
        cachedInputTokens: 8576,
        outputTokens: 17,
        reasoningOutputTokens: 0,
        totalTokens: 10374
      }
    });
  });

  it("wraps codex spawn with cmd.exe on windows when resolved command is cmd shim", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const mockedSpawn = vi.mocked(spawn);
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: {
        write: vi.fn(),
        end: vi.fn()
      },
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
        expect.arrayContaining(["/d", "/c"]),
        expect.objectContaining({
          detached: false,
          windowsHide: true
        })
      );
      const spawnArgs = mockedSpawn.mock.calls[0]?.[1] as string[];
      expect(spawnArgs[2]).toContain('"C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd"');
      expect(spawnArgs[2]).toContain("exec");
      expect(spawnArgs[2]).toContain(" -");
      expect(child.unref).not.toHaveBeenCalled();
      expect(child.stdin.write).toHaveBeenCalledWith("windows probe\n");
      expect(child.stdin.end).toHaveBeenCalled();
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("resolves ~ path from USERPROFILE when HOME is empty", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const mockedSpawn = vi.mocked(spawn);
    const tempHomeDir = mkdtempSync(join(tmpdir(), "codex-dispatch-home-"));
    const actualProjectDir = mkdtempSync(join(tempHomeDir, "demo-project-"));

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = "";
    process.env.USERPROFILE = tempHomeDir;

    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: {
        write: vi.fn(),
        end: vi.fn()
      },
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

      const tildePath = `~\\${actualProjectDir.slice(tempHomeDir.length + 1)}`;
      const result = service.dispatchTask({
        taskId: "task-home-001",
        sessionId: "session-home-001",
        prompt: "home probe",
        actorId: "ou_test",
        projectPath: tildePath
      });

      expect(result.accepted).toBe(true);
      expect(mockedSpawn).toHaveBeenCalledWith(
        "codex",
        expect.any(Array),
        expect.objectContaining({
          cwd: actualProjectDir
        })
      );
    } finally {
      platformSpy.mockRestore();
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
      rmSync(tempHomeDir, { recursive: true, force: true });
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

function firstEventPayload(handleEvent: ReturnType<typeof vi.fn>) {
  const calls = handleEvent.mock.calls as unknown as Array<[unknown]>;
  const firstCall = calls[0];
  expect(firstCall).toBeDefined();
  return firstCall![0] as {
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
}
