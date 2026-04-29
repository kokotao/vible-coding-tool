/**
 * @description Codex 执行调度器，将网关任务异步投递到 codex exec/resume 并回灌任务结果事件
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-26 23:34
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import { AuditLogRepository } from "../../storage/repositories/audit-log-repository";
import { ToolSessionRepository } from "../../storage/repositories/tool-session-repository";
import { CodexEventService } from "./codex-event-service";
import { CodexCliRuntimeService } from "./codex-cli-runtime-service";
import {
  parseCodexTokenCountSnapshot,
  type CodexRuntimeMeta
} from "./codex-runtime-meta";

type CodexDispatchServiceDeps = {
  codexEventService: CodexEventService;
  auditLogRepository: AuditLogRepository;
  toolSessionRepository: ToolSessionRepository;
  codexCliRuntimeService: CodexCliRuntimeService;
};

type SpawnInvocation = {
  command: string;
  args: string[];
};

export type DispatchTaskInput = {
  taskId: string;
  sessionId: string;
  prompt: string;
  actorId: string;
  threadRef?: string | null;
  modelSlug?: string | null;
  projectPath?: string | null;
};

export type DispatchTaskResult = {
  accepted: boolean;
  skipped: boolean;
  reason: string | null;
  pid: number | null;
  threadRef: string | null;
  command: string[];
};

export class CodexDispatchService {
  constructor(
    private readonly deps: CodexDispatchServiceDeps,
    private readonly options: {
      enabled: boolean;
      codexBin: string;
      skipGitRepoCheck: boolean;
    }
  ) {}

  dispatchTask(input: DispatchTaskInput): DispatchTaskResult {
    const prompt = input.prompt.trim();
    const threadRef = this.resolveThreadRef(input.sessionId, input.threadRef);
    const modelSlug = (input.modelSlug || "").trim() || null;
    if (!prompt) {
      return {
        accepted: false,
        skipped: true,
        reason: "empty_prompt",
        pid: null,
        threadRef,
        command: []
      };
    }

    if (!this.options.enabled) {
      return {
        accepted: false,
        skipped: true,
        reason: "dispatch_disabled",
        pid: null,
        threadRef,
        command: []
      };
    }
    const runtimeContext = this.deps.codexCliRuntimeService.prepareDispatchContext();
    if (!runtimeContext.ready) {
      return {
        accepted: false,
        skipped: true,
        reason: runtimeContext.reason,
        pid: null,
        threadRef,
        command: []
      };
    }
    const workingDirectory = this.resolveWorkingDirectory(input.projectPath ?? null);
    if (!workingDirectory) {
      return {
        accepted: false,
        skipped: true,
        reason: "project_path_not_found",
        pid: null,
        threadRef,
        command: []
      };
    }

    const commandBin = runtimeContext.codexBin || this.options.codexBin;
    const commandArgs = this.buildCommandArgs(prompt, threadRef, modelSlug, runtimeContext.extraArgs);
    const spawnInvocation = this.resolveSpawnInvocation(commandBin, commandArgs);
    const command = [commandBin, ...commandArgs];
    const now = new Date().toISOString();
    const startedAtMs = Date.now();

    let settled = false;

    try {
      const child = spawn(spawnInvocation.command, spawnInvocation.args, {
        cwd: workingDirectory,
        env: runtimeContext.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        windowsHide: process.platform === "win32"
      });

      let stdoutTail = "";
      let stderrTail = "";
      const tailLimit = 30_000;

      child.stdout?.on("data", (chunk) => {
        const text = String(chunk);
        stdoutTail = `${stdoutTail}${text}`.slice(-tailLimit);
      });

      child.stderr?.on("data", (chunk) => {
        const text = String(chunk);
        stderrTail = `${stderrTail}${text}`.slice(-tailLimit);
      });

      child.on("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        void this.emitDispatchFailedEvent(
          input,
          threadRef,
          `dispatch spawn failed: ${error instanceof Error ? error.message : String(error)}`,
          {
            durationMs: Date.now() - startedAtMs,
            modelSlug
          }
        );
      });

      child.on("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        const mergedOutput = `${stdoutTail}\n${stderrTail}`.trim();
        const resolvedThreadRef = this.extractThreadRef(mergedOutput) || threadRef;
        const runtimeMeta = this.extractRuntimeMeta(mergedOutput, modelSlug, Date.now() - startedAtMs);
        void this.emitCloseEvent(input, code ?? 1, mergedOutput, resolvedThreadRef, runtimeMeta);
      });

      child.unref();

      this.deps.auditLogRepository.create({
        eventId: randomUUID(),
        taskId: input.taskId,
        sessionId: input.sessionId,
        action: "dispatch_task",
        actorId: input.actorId,
        result: "accepted",
        detail: `pid=${child.pid ?? "unknown"}; thread=${threadRef || "new"}; model=${modelSlug || "default"}; cwd=${workingDirectory}; cmd=${command.join(" ")}; trusted=${runtimeContext.authorization.trustedInConfig}; trustUpdated=${runtimeContext.authorization.trustUpdated}; trustWarning=${runtimeContext.authorization.warning || "none"}`,
        createdAt: now
      });

      return {
        accepted: true,
        skipped: false,
        reason: null,
        pid: child.pid ?? null,
        threadRef,
        command
      };
    } catch (error) {
      void this.emitDispatchFailedEvent(
        input,
        threadRef,
        `dispatch exception: ${error instanceof Error ? error.message : String(error)}`,
        {
          durationMs: Date.now() - startedAtMs,
          modelSlug
        }
      );
      return {
        accepted: false,
        skipped: false,
        reason: "spawn_failed",
        pid: null,
        threadRef,
        command
      };
    }
  }

  private resolveThreadRef(sessionId: string, explicitThreadRef?: string | null) {
    const explicit = (explicitThreadRef || "").trim();
    if (this.isThreadRef(explicit)) {
      return explicit;
    }

    const existingSession = this.deps.toolSessionRepository.findBySessionId(sessionId);
    const sessionThread = existingSession?.toolSessionRef?.trim() || "";
    if (this.isThreadRef(sessionThread)) {
      return sessionThread;
    }

    return null;
  }

  private resolveWorkingDirectory(projectPath: string | null) {
    const normalized = (projectPath || "").trim();
    if (!normalized) {
      return process.cwd();
    }

    const expandedHome =
      normalized.startsWith("~/") && process.env.HOME
        ? resolve(process.env.HOME, normalized.slice(2))
        : normalized;
    const candidate = isAbsolute(expandedHome) ? expandedHome : resolve(process.cwd(), expandedHome);
    if (!this.isDirectory(candidate)) {
      return null;
    }
    return candidate;
  }

  private isDirectory(path: string) {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }

  private buildCommandArgs(
    prompt: string,
    threadRef: string | null,
    modelSlug: string | null,
    accessArgs: string[]
  ) {
    const args: string[] = [];
    if (accessArgs.length > 0) {
      args.push(...accessArgs);
    }
    args.push("exec", "--json");
    if (this.options.skipGitRepoCheck) {
      args.push("--skip-git-repo-check");
    }

    if (modelSlug) {
      args.push("--model", modelSlug);
    }

    if (threadRef) {
      args.push("resume", threadRef, prompt);
      return args;
    }

    args.push(prompt);
    return args;
  }

  private resolveSpawnInvocation(commandBin: string, commandArgs: string[]): SpawnInvocation {
    if (process.platform !== "win32") {
      return {
        command: commandBin,
        args: commandArgs
      };
    }

    const ext = extname(commandBin).toLowerCase();
    const useCmdWrapper = ext === ".cmd" || ext === ".bat" || ext.length === 0;
    if (!useCmdWrapper) {
      return {
        command: commandBin,
        args: commandArgs
      };
    }

    const cmdline = this.buildWindowsCmdline(commandBin, commandArgs);
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", cmdline]
    };
  }

  private buildWindowsCmdline(commandBin: string, commandArgs: string[]) {
    return [this.quoteWindowsArg(commandBin), ...commandArgs.map((arg) => this.quoteWindowsArg(arg))].join(" ");
  }

  private quoteWindowsArg(value: string) {
    const sanitized = value.replace(/\r?\n/g, " ").replaceAll("%", "%%").replaceAll('"', '""');
    return `"${sanitized}"`;
  }

  private isThreadRef(value: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  }

  private extractThreadRef(raw: string) {
    for (const line of raw.split(/\r?\n/)) {
      const text = line.trim();
      if (!text.startsWith("{")) {
        continue;
      }
      try {
        const parsed = JSON.parse(text) as {
          type?: string;
          thread_id?: string;
        };
        if (parsed.type === "thread.started" && typeof parsed.thread_id === "string" && this.isThreadRef(parsed.thread_id)) {
          return parsed.thread_id;
        }
      } catch {
        continue;
      }
    }

    const matched = raw.match(/"thread_id"\s*:\s*"([0-9a-fA-F-]{36})"/);
    if (matched && this.isThreadRef(matched[1])) {
      return matched[1];
    }
    return null;
  }

  private extractFinalAgentMessage(raw: string) {
    let output: string | null = null;
    for (const line of raw.split(/\r?\n/)) {
      const text = line.trim();
      if (!text.startsWith("{")) {
        continue;
      }

      try {
        const parsed = JSON.parse(text) as {
          type?: string;
          item?: {
            type?: string;
            text?: string;
          };
        };
        if (parsed.type === "item.completed" && parsed.item?.type === "agent_message" && typeof parsed.item.text === "string") {
          output = parsed.item.text.trim() || output;
        }
      } catch {
        continue;
      }
    }

    return output;
  }

  private extractRuntimeMeta(raw: string, modelSlug: string | null, durationMs: number) {
    let latestTokenCount: ReturnType<typeof parseCodexTokenCountSnapshot> | null = null;

    for (const line of raw.split(/\r?\n/)) {
      const text = line.trim();
      if (!text.startsWith("{")) {
        continue;
      }

      try {
        const parsed = JSON.parse(text) as {
          type?: string;
          payload?: Record<string, unknown>;
          info?: Record<string, unknown>;
        };

        if (parsed.type !== "token_count") {
          continue;
        }

        const snapshot = parseCodexTokenCountSnapshot(parsed);
        if (snapshot) {
          latestTokenCount = snapshot;
        }
      } catch {
        continue;
      }
    }

    return {
      durationMs,
      tokenUsage: latestTokenCount?.totalUsage?.totalTokens ?? null,
      tokenUsageDetail: latestTokenCount?.totalUsage ?? null,
      lastTokenUsageDetail: latestTokenCount?.lastUsage ?? null,
      modelSlug
    } satisfies CodexRuntimeMeta;
  }

  private sanitizeText(value: string, maxLength: number) {
    const cleaned = value.replace(/\u0000/g, "").trim();
    if (!cleaned) {
      return "";
    }
    if (cleaned.length <= maxLength) {
      return cleaned;
    }
    return `${cleaned.slice(0, maxLength - 3)}...`;
  }

  private async emitDispatchFailedEvent(
    input: DispatchTaskInput,
    threadRef: string | null,
    detail: string,
    runtimeMeta?: CodexRuntimeMeta
  ) {
    const now = new Date().toISOString();
    await this.deps.codexEventService.handleEvent({
      eventId: randomUUID(),
      taskId: input.taskId,
      sessionId: input.sessionId,
      toolSessionRef: threadRef || undefined,
      status: "failed",
      summary: "Codex任务失败：调度异常",
      detail: this.sanitizeText(detail, 1800),
      senderId: "codex_dispatcher",
      occurredAt: now,
      runtimeMeta: runtimeMeta ?? null
    });
  }

  private async emitCloseEvent(
    input: DispatchTaskInput,
    exitCode: number,
    output: string,
    threadRef: string | null,
    runtimeMeta?: CodexRuntimeMeta
  ) {
    const now = new Date().toISOString();
    const finalMessage = this.extractFinalAgentMessage(output);
    const detail = this.sanitizeText(finalMessage || output || `codex exited with code ${exitCode}`, 1800);

    if (exitCode === 0) {
      await this.deps.codexEventService.handleEvent({
        eventId: randomUUID(),
        taskId: input.taskId,
        sessionId: input.sessionId,
        toolSessionRef: threadRef || undefined,
        status: "succeeded",
        summary: `Codex任务完成：${this.sanitizeText(finalMessage || "OK", 120)}`,
        detail: detail || "OK",
        senderId: "codex_dispatcher",
        occurredAt: now,
        runtimeMeta: runtimeMeta ?? null
      });
      return;
    }

    await this.deps.codexEventService.handleEvent({
      eventId: randomUUID(),
      taskId: input.taskId,
      sessionId: input.sessionId,
      toolSessionRef: threadRef || undefined,
      status: "failed",
      summary: `Codex任务失败：exit=${exitCode}`,
      detail: detail || `codex exited with code ${exitCode}`,
      senderId: "codex_dispatcher",
      occurredAt: now,
      runtimeMeta: runtimeMeta ?? null
    });
  }
}
