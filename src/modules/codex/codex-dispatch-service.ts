/**
 * @description Codex 执行调度器，将网关任务异步投递到 codex exec/resume 并回灌任务结果事件
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-26 23:34
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve, join } from "node:path";
import { AuditLogRepository } from "../../storage/repositories/audit-log-repository";
import { ToolSessionRepository } from "../../storage/repositories/tool-session-repository";
import { CodexEventService } from "./codex-event-service";
import { CodexCliRuntimeService } from "./codex-cli-runtime-service";
import {
  parseCodexTokenCountSnapshotFromEventRecord,
  parseCodexTokenCountSnapshot,
  resolveCodexTaskTokenUsage,
  type CodexRuntimeMeta,
  type CodexTokenUsageBreakdown
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
  modelReasoningLevel?: string | null;
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

type ActiveDispatchRuntime = {
  child: ChildProcessWithoutNullStreams;
  pid: number | null;
  sessionId: string;
  threadRef: string | null;
  outputLastMessagePath: string | null;
  stdoutTail: string;
  stderrTail: string;
  stdoutBuffer: string;
  stderrBuffer: string;
};

export type InterruptTaskResult = {
  accepted: boolean;
  stopped: boolean;
  reason: string | null;
  taskId: string;
  sessionId: string;
  threadRef: string | null;
  pid: number | null;
  stopMessage: string | null;
  method: "codex_cli_resume" | "process_signal" | "none";
};

export class CodexDispatchService {
  private readonly activeDispatches = new Map<string, ActiveDispatchRuntime>();

  constructor(
    private readonly deps: CodexDispatchServiceDeps,
    private readonly options: {
      enabled: boolean;
      codexBin: string;
      skipGitRepoCheck: boolean;
    }
  ) {}

  async interruptTask(input: {
    taskId: string;
    sessionId: string;
    actorId: string;
    threadRef?: string | null;
    projectPath?: string | null;
  }): Promise<InterruptTaskResult> {
    const active = this.activeDispatches.get(input.taskId) || null;
    const threadRef = this.resolveThreadRef(input.sessionId, input.threadRef || active?.threadRef || null);
    const pid = active?.pid ?? null;

    let stopMessage: string | null = null;
    let stopViaCliOk = false;
    if (threadRef) {
      const cliStop = await this.requestStopViaCli({
        taskId: input.taskId,
        sessionId: input.sessionId,
        threadRef,
        projectPath: input.projectPath ?? null
      });
      stopMessage = cliStop.message;
      stopViaCliOk = cliStop.ok;
    }

    let signalSent = false;
    if (active?.child && !active.child.killed) {
      try {
        signalSent = active.child.kill("SIGTERM");
      } catch {
        signalSent = false;
      }
    }
    if (!signalSent && pid) {
      try {
        process.kill(pid, "SIGTERM");
        signalSent = true;
      } catch {
        signalSent = false;
      }
    }

    const fallbackMessage =
      stopMessage ||
      this.readOutputLastMessageFile(active?.outputLastMessagePath || null) ||
      this.extractFinalAgentMessage(`${active?.stdoutTail || ""}\n${active?.stderrTail || ""}`) ||
      null;

    this.deps.auditLogRepository.create({
      eventId: randomUUID(),
      taskId: input.taskId,
      sessionId: input.sessionId,
      action: "dispatch_interrupt_task",
      actorId: input.actorId,
      result: stopViaCliOk || signalSent ? "success" : "failed",
      detail: `thread=${threadRef || "null"}; pid=${pid ?? "null"}; cliStop=${stopViaCliOk}; signalSent=${signalSent}`,
      createdAt: new Date().toISOString()
    });

    return {
      accepted: Boolean(active || threadRef),
      stopped: stopViaCliOk || signalSent,
      reason: stopViaCliOk || signalSent ? null : "task_not_running_or_unreachable",
      taskId: input.taskId,
      sessionId: input.sessionId,
      threadRef,
      pid,
      stopMessage: fallbackMessage,
      method: stopViaCliOk ? "codex_cli_resume" : signalSent ? "process_signal" : "none"
    };
  }

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
    const outputLastMessagePath = this.buildOutputLastMessagePath(input.taskId);
    const commandArgs = this.buildCommandArgs(prompt, threadRef, modelSlug, runtimeContext.extraArgs, outputLastMessagePath);
    const spawnInvocation = this.resolveSpawnInvocation(commandBin, commandArgs);
    const command = [commandBin, ...commandArgs];
    const now = new Date().toISOString();
    const startedAtMs = Date.now();
    const runDetached = process.platform !== "win32";

    let settled = false;

    try {
      const child = spawn(spawnInvocation.command, spawnInvocation.args, {
        cwd: workingDirectory,
        env: runtimeContext.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: runDetached,
        windowsHide: process.platform === "win32"
      });
      this.writePromptToStdin(child.stdin, prompt);

      let stdoutTail = "";
      let stderrTail = "";
      let stdoutBuffer = "";
      let stderrBuffer = "";
      let streamedLatestTokenCount: ReturnType<typeof parseCodexTokenCountSnapshot> | null = null;
      const baselineTokenUsageDetail = threadRef ? this.readLatestThreadTokenUsage(threadRef, runtimeContext.env) : null;
      const tailLimit = 30_000;

      this.activeDispatches.set(input.taskId, {
        child,
        pid: child.pid ?? null,
        sessionId: input.sessionId,
        threadRef,
        outputLastMessagePath,
        stdoutTail,
        stderrTail,
        stdoutBuffer,
        stderrBuffer
      });

      child.stdout?.on("data", (chunk) => {
        const text = String(chunk);
        stdoutTail = `${stdoutTail}${text}`.slice(-tailLimit);
        const parsed = this.consumeJsonLines(`${stdoutBuffer}${text}`, (line) => this.extractTokenCountSnapshotFromLine(line));
        stdoutBuffer = parsed.rest;
        if (parsed.latestTokenCount) {
          streamedLatestTokenCount = parsed.latestTokenCount;
        }
        const startedThread = this.extractThreadRef(text);
        const runtime = this.activeDispatches.get(input.taskId);
        if (runtime) {
          runtime.stdoutTail = stdoutTail;
          runtime.stdoutBuffer = stdoutBuffer;
          if (startedThread && !runtime.threadRef) {
            runtime.threadRef = startedThread;
          }
        }
      });

      child.stderr?.on("data", (chunk) => {
        const text = String(chunk);
        stderrTail = `${stderrTail}${text}`.slice(-tailLimit);
        const parsed = this.consumeJsonLines(`${stderrBuffer}${text}`, (line) => this.extractTokenCountSnapshotFromLine(line));
        stderrBuffer = parsed.rest;
        if (parsed.latestTokenCount) {
          streamedLatestTokenCount = parsed.latestTokenCount;
        }
        const runtime = this.activeDispatches.get(input.taskId);
        if (runtime) {
          runtime.stderrTail = stderrTail;
          runtime.stderrBuffer = stderrBuffer;
        }
      });

      child.on("error", (error) => {
        this.cleanupOutputLastMessageFile(outputLastMessagePath);
        this.activeDispatches.delete(input.taskId);
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
        const outputLastMessage = this.readOutputLastMessageFile(outputLastMessagePath);
        this.cleanupOutputLastMessageFile(outputLastMessagePath);
        const runtime = this.activeDispatches.get(input.taskId);
        this.activeDispatches.delete(input.taskId);
        if (settled) {
          return;
        }
        settled = true;
        const mergedOutput = `${stdoutTail}\n${stderrTail}`.trim();
        const resolvedThreadRef = runtime?.threadRef || this.extractThreadRef(mergedOutput) || threadRef;
        const trailingStdoutTokenCount = this.extractTokenCountSnapshotFromLine(stdoutBuffer);
        if (trailingStdoutTokenCount) {
          streamedLatestTokenCount = trailingStdoutTokenCount;
        }
        const trailingStderrTokenCount = this.extractTokenCountSnapshotFromLine(stderrBuffer);
        if (trailingStderrTokenCount) {
          streamedLatestTokenCount = trailingStderrTokenCount;
        }
        const runtimeMeta = this.extractRuntimeMeta(
          mergedOutput,
          modelSlug,
          Date.now() - startedAtMs,
          streamedLatestTokenCount,
          baselineTokenUsageDetail
        );
        void this.emitCloseEvent(input, code ?? 1, mergedOutput, resolvedThreadRef, runtimeMeta, outputLastMessage);
      });

      if (runDetached) {
        child.unref();
      }

    this.deps.auditLogRepository.create({
      eventId: randomUUID(),
      taskId: input.taskId,
      sessionId: input.sessionId,
      action: "dispatch_task",
      actorId: input.actorId,
      result: "accepted",
      detail: `pid=${child.pid ?? "unknown"}; thread=${threadRef || "new"}; model=${modelSlug || "default"}; reasoning=${input.modelReasoningLevel || "default"}; cwd=${workingDirectory}; cmd=${command.join(" ")}; trusted=${runtimeContext.authorization.trustedInConfig}; trustUpdated=${runtimeContext.authorization.trustUpdated}; trustWarning=${runtimeContext.authorization.warning || "none"}`,
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
      this.cleanupOutputLastMessageFile(outputLastMessagePath);
      this.activeDispatches.delete(input.taskId);
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

    const homeDir =
      process.env.HOME?.trim() ||
      process.env.USERPROFILE?.trim() ||
      `${process.env.HOMEDRIVE || ""}${process.env.HOMEPATH || ""}`.trim();
    const expandedHome =
      (normalized.startsWith("~/") || normalized.startsWith("~\\")) && homeDir
        ? resolve(homeDir, normalized.slice(2))
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
    accessArgs: string[],
    outputLastMessagePath: string | null
  ) {
    const args: string[] = [];
    if (accessArgs.length > 0) {
      args.push(...accessArgs);
    }
    args.push("exec", "--json");
    if (outputLastMessagePath) {
      args.push("--output-last-message", outputLastMessagePath);
    }
    if (this.options.skipGitRepoCheck) {
      args.push("--skip-git-repo-check");
    }

    if (modelSlug) {
      args.push("--model", modelSlug);
    }

    if (threadRef) {
      args.push("resume", threadRef, "-");
      return args;
    }

    args.push("-");
    return args;
  }

  private buildStopCommandArgs(threadRef: string, accessArgs: string[], outputLastMessagePath: string | null) {
    const args: string[] = [];
    if (accessArgs.length > 0) {
      args.push(...accessArgs);
    }
    args.push("exec", "--json");
    if (outputLastMessagePath) {
      args.push("--output-last-message", outputLastMessagePath);
    }
    if (this.options.skipGitRepoCheck) {
      args.push("--skip-git-repo-check");
    }
    args.push("resume", threadRef, "-");
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
      args: ["/d", "/c", cmdline]
    };
  }

  private buildWindowsCmdline(commandBin: string, commandArgs: string[]) {
    const commandToken = this.isBareWindowsCommand(commandBin) ? commandBin : this.quoteWindowsArg(commandBin);
    return [commandToken, ...commandArgs.map((arg) => this.toWindowsCmdArg(arg))].join(" ");
  }

  private isBareWindowsCommand(value: string) {
    return /^[A-Za-z0-9_.-]+$/.test(value);
  }

  private toWindowsCmdArg(value: string) {
    if (!this.needsWindowsQuote(value)) {
      return value;
    }
    return this.quoteWindowsArg(value);
  }

  private needsWindowsQuote(value: string) {
    return /[\s"&|<>^()%!]/.test(value);
  }

  private writePromptToStdin(
    stdin: {
      write: (chunk: string) => void;
      end: () => void;
    } | null
      | undefined,
    prompt: string
  ) {
    if (!stdin) {
      return;
    }
    try {
      stdin.write(prompt.endsWith("\n") ? prompt : `${prompt}\n`);
      stdin.end();
    } catch {
      try {
        stdin.end();
      } catch {
        // ignore stdin cleanup failures
      }
    }
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

  private extractRuntimeMeta(
    raw: string,
    modelSlug: string | null,
    durationMs: number,
    fallbackTokenCount?: ReturnType<typeof parseCodexTokenCountSnapshot> | null,
    baselineTokenUsageDetail?: CodexTokenUsageBreakdown | null
  ) {
    let latestTokenCount: ReturnType<typeof parseCodexTokenCountSnapshot> | null = fallbackTokenCount ?? null;
    if (!latestTokenCount) {
      for (const line of raw.split(/\r?\n/)) {
        const snapshot = this.extractTokenCountSnapshotFromLine(line);
        if (snapshot) {
          latestTokenCount = snapshot;
        }
      }
    }

    const cumulativeTokenUsageDetail = latestTokenCount?.totalUsage ?? null;
    const taskTokenUsage = resolveCodexTaskTokenUsage({
      baselineUsage: baselineTokenUsageDetail ?? null,
      totalUsage: cumulativeTokenUsageDetail,
      lastUsage: latestTokenCount?.lastUsage ?? null
    });

    return {
      durationMs,
      tokenUsage: taskTokenUsage?.usage?.totalTokens ?? null,
      tokenUsageDetail: taskTokenUsage?.usage ?? null,
      tokenUsageSource: taskTokenUsage?.source ?? null,
      cumulativeTokenUsageDetail,
      baselineTokenUsageDetail: baselineTokenUsageDetail ?? null,
      lastTokenUsageDetail: latestTokenCount?.lastUsage ?? null,
      modelSlug
    } satisfies CodexRuntimeMeta;
  }

  private readLatestThreadTokenUsage(threadRef: string, env: NodeJS.ProcessEnv) {
    const normalizedThreadRef = threadRef.trim();
    if (!this.isThreadRef(normalizedThreadRef)) {
      return null;
    }

    const codexHome = (env.CODEX_HOME || process.env.CODEX_HOME || "").trim();
    const sessionsRoot = codexHome
      ? resolve(codexHome, "sessions")
      : resolve(process.env.USERPROFILE || process.env.HOME || ".", ".codex", "sessions");
    const rolloutFile = this.findRolloutFileByThreadRef(sessionsRoot, normalizedThreadRef);
    if (!rolloutFile) {
      return null;
    }

    try {
      const content = readFileSync(rolloutFile, "utf8");
      let latest: CodexTokenUsageBreakdown | null = null;
      for (const line of content.split(/\r?\n/)) {
        const snapshot = this.extractTokenCountSnapshotFromLine(line);
        if (snapshot?.totalUsage) {
          latest = snapshot.totalUsage;
        }
      }
      return latest;
    } catch {
      return null;
    }
  }

  private findRolloutFileByThreadRef(root: string, threadRef: string): string | null {
    if (!existsSync(root)) {
      return null;
    }

    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const entryPath = join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(entryPath);
          continue;
        }
        if (entry.isFile() && entry.name.includes(threadRef) && /^rollout-.*\.jsonl$/i.test(entry.name)) {
          return entryPath;
        }
      }
    }

    return null;
  }

  private extractTokenCountSnapshotFromLine(line: string) {
    const text = line.trim();
    if (!text.startsWith("{")) {
      return null;
    }

    try {
      const parsed = JSON.parse(text) as {
        type?: string;
        payload?: Record<string, unknown>;
        info?: Record<string, unknown>;
        usage?: Record<string, unknown>;
      };
      return parseCodexTokenCountSnapshotFromEventRecord(parsed);
    } catch {
      return null;
    }
  }

  private consumeJsonLines(
    input: string,
    parseLine: (line: string) => ReturnType<typeof parseCodexTokenCountSnapshot> | null
  ) {
    const lines = input.split(/\r?\n/);
    const rest = lines.pop() || "";
    let latestTokenCount: ReturnType<typeof parseCodexTokenCountSnapshot> | null = null;
    for (const line of lines) {
      const snapshot = parseLine(line);
      if (snapshot) {
        latestTokenCount = snapshot;
      }
    }
    return {
      rest,
      latestTokenCount
    };
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

  private buildOutputLastMessagePath(taskId: string) {
    try {
      const dir = resolve(process.cwd(), "data", "codex-last-message");
      mkdirSync(dir, { recursive: true });
      const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
      return join(dir, `${safeTaskId}-${Date.now()}.txt`);
    } catch {
      return null;
    }
  }

  private readOutputLastMessageFile(path: string | null) {
    if (!path) {
      return null;
    }
    try {
      const content = readFileSync(path, "utf8").replace(/\u0000/g, "").trim();
      return content || null;
    } catch {
      return null;
    }
  }

  private cleanupOutputLastMessageFile(path: string | null) {
    if (!path) {
      return;
    }
    try {
      rmSync(path, { force: true });
    } catch {
      // ignore cleanup errors
    }
  }

  private async requestStopViaCli(input: {
    taskId: string;
    sessionId: string;
    threadRef: string;
    projectPath: string | null;
  }) {
    const runtimeContext = this.deps.codexCliRuntimeService.prepareDispatchContext();
    if (!runtimeContext.ready) {
      return { ok: false, message: null };
    }
    const cwd = this.resolveWorkingDirectory(input.projectPath);
    if (!cwd) {
      return { ok: false, message: null };
    }

    const stopPrompt = "Stop the current task immediately and reply with a concise summary of work completed so far.";
    const outputPath = this.buildOutputLastMessagePath(`${input.taskId}-stop`);
    const args = this.buildStopCommandArgs(input.threadRef, runtimeContext.extraArgs, outputPath);
    const commandBin = runtimeContext.codexBin || this.options.codexBin;
    const spawnInvocation = this.resolveSpawnInvocation(commandBin, args);

    return await new Promise<{ ok: boolean; message: string | null }>((resolvePromise) => {
      let stdoutTail = "";
      let stderrTail = "";
      const stopChild = spawn(spawnInvocation.command, spawnInvocation.args, {
        cwd,
        env: runtimeContext.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: process.platform === "win32"
      });
      this.writePromptToStdin(stopChild.stdin, stopPrompt);

      stopChild.stdout?.on("data", (chunk) => {
        stdoutTail = `${stdoutTail}${String(chunk)}`.slice(-30_000);
      });
      stopChild.stderr?.on("data", (chunk) => {
        stderrTail = `${stderrTail}${String(chunk)}`.slice(-30_000);
      });

      const timer = setTimeout(() => {
        try {
          stopChild.kill("SIGTERM");
        } catch {
          // ignore timeout kill failure
        }
      }, 25_000);

      stopChild.on("error", () => {
        clearTimeout(timer);
        const message = this.readOutputLastMessageFile(outputPath);
        this.cleanupOutputLastMessageFile(outputPath);
        resolvePromise({ ok: false, message });
      });

      stopChild.on("close", (code) => {
        clearTimeout(timer);
        const fileMessage = this.readOutputLastMessageFile(outputPath);
        this.cleanupOutputLastMessageFile(outputPath);
        const mergedOutput = `${stdoutTail}\n${stderrTail}`;
        const extracted = this.extractFinalAgentMessage(mergedOutput);
        resolvePromise({
          ok: code === 0,
          message: fileMessage || extracted || null
        });
      });
    });
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
    runtimeMeta?: CodexRuntimeMeta,
    outputLastMessage?: string | null
  ) {
    const now = new Date().toISOString();
    const finalMessage = this.extractFinalAgentMessage(output) || (outputLastMessage || "").trim() || null;
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
