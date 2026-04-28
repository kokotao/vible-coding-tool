/**
 * @description Codex 调度器回归测试，确保 close 事件回灌完整 runtimeMeta
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-28 17:50
 */
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexDispatchService } from "../../src/modules/codex/codex-dispatch-service";

vi.mock("node:child_process", () => ({
  spawn: vi.fn()
}));

describe("codex dispatch service", () => {
  afterEach(() => {
    vi.clearAllMocks();
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
