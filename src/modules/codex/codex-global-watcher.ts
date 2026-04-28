/**
 * @description Codex 本地 rollout watcher 模块，扫描 task_complete 事件并回推网关
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-27 10:43
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveFeishuWatcherRecipientOpenId } from "../feishu/feishu-open-id-resolver";
import {
  parseCodexTokenCountSnapshot,
  type CodexRuntimeMeta,
  type CodexTokenUsageBreakdown
} from "./codex-runtime-meta";

const THREAD_ID_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const MAX_PROCESSED_KEYS = 5000;
type WatcherLogger = Pick<Console, "info" | "warn" | "error">;

type WatcherState = {
  version: 1;
  initialized: boolean;
  fileOffsets: Record<string, number>;
  processedEventKeys: string[];
  updatedAt: string;
};

type TurnRuntimeState = {
  startedAt: string | null;
  modelSlug: string | null;
  tokenUsage: number | null;
  tokenUsageDetail: CodexTokenUsageBreakdown | null;
  lastTokenUsageDetail: CodexTokenUsageBreakdown | null;
};

export type StartCodexGlobalWatcherArgs = {
  gatewayUrl: string;
  statePath: string;
  pollIntervalMs: number;
  sessionId: string | null;
  senderId: string;
  recipientOpenId: string | null;
  sessionsRoot: string;
  archivedSessionsRoot: string;
  scanArchived: boolean;
  bootstrapMode: "tail" | "replay";
  ingressToken?: string;
  signingSecret?: string;
  fetchImpl?: typeof fetch;
  logger?: WatcherLogger;
};

export type CodexGlobalWatcherHandle = {
  stop: () => Promise<void>;
};

export type CodexGlobalWatcherDefaults = {
  autoStart: boolean;
  statePath: string;
  pollIntervalMs: number;
  sessionId: string | null;
  senderId: string;
  recipientOpenId: string | null;
  sessionsRoot: string;
  archivedSessionsRoot: string;
  scanArchived: boolean;
  bootstrapMode: "tail" | "replay";
  ingressToken?: string;
  signingSecret?: string;
};

export type CodexGlobalWatcherRuntimeStatus = {
  running: boolean;
  autoStartConfigured: boolean;
  statePath: string | null;
  sessionsRoot: string | null;
  archivedSessionsRoot: string | null;
  scanArchived: boolean;
  bootstrapMode: "tail" | "replay" | null;
  sessionId: string | null;
  senderId: string | null;
  recipientOpenId: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  lastTickAt: string | null;
  lastSuccessfulPostAt: string | null;
  lastPostedEventId: string | null;
  lastError: string | null;
};

const codexGlobalWatcherRuntimeStatus: Omit<CodexGlobalWatcherRuntimeStatus, "autoStartConfigured"> = {
  running: false,
  statePath: null,
  sessionsRoot: null,
  archivedSessionsRoot: null,
  scanArchived: false,
  bootstrapMode: null,
  sessionId: null,
  senderId: null,
  recipientOpenId: null,
  startedAt: null,
  stoppedAt: null,
  lastTickAt: null,
  lastSuccessfulPostAt: null,
  lastPostedEventId: null,
  lastError: null
};

export async function startCodexGlobalWatcher(args: StartCodexGlobalWatcherArgs) {
  const startedAt = new Date().toISOString();
  updateWatcherRuntimeStatus({
    running: true,
    statePath: resolve(args.statePath),
    sessionsRoot: resolve(args.sessionsRoot),
    archivedSessionsRoot: resolve(args.archivedSessionsRoot),
    scanArchived: args.scanArchived,
    bootstrapMode: args.bootstrapMode,
    sessionId: args.sessionId,
    senderId: args.senderId,
    recipientOpenId: args.recipientOpenId,
    startedAt,
    stoppedAt: null,
    lastError: null
  });

  const watcher = new CodexGlobalWatcher(args);
  try {
    await watcher.start();
    updateWatcherRuntimeStatus({
      running: true,
      startedAt,
      stoppedAt: null,
      lastError: null
    });
    const handle: CodexGlobalWatcherHandle = {
      stop: () => watcher.stop()
    };
    return handle;
  } catch (error) {
    updateWatcherRuntimeStatus({
      running: false,
      startedAt: null,
      lastError: toErrorMessage(error)
    });
    throw error;
  }
}

export function resolveCodexGlobalWatcherDefaults(): CodexGlobalWatcherDefaults {
  const sessionId = normalizeNullable(process.env.CODEX_WATCH_SESSION_ID);
  const recipientOpenId = normalizeNullable(process.env.CODEX_WATCH_RECIPIENT_OPEN_ID);
  const senderId = normalizeNullable(process.env.CODEX_WATCH_SENDER_ID) || "codex_global_watcher";
  const autoStart = parseBoolean(
    process.env.CODEX_WATCH_AUTO_START || (sessionId || recipientOpenId ? "true" : "false")
  );
  const bootstrap = normalizeNullable(process.env.CODEX_WATCH_BOOTSTRAP)?.toLowerCase();
  const bootstrapMode = bootstrap === "replay" ? "replay" : "tail";

  return {
    autoStart,
    statePath: normalizeNullable(process.env.CODEX_WATCH_STATE_PATH) || "./data/codex-watcher-state.json",
    pollIntervalMs: parsePositiveInt(process.env.CODEX_WATCH_POLL_MS, 3000, 500),
    sessionId,
    senderId,
    recipientOpenId,
    sessionsRoot: resolveHomePath(process.env.CODEX_SESSIONS_ROOT || "~/.codex/sessions"),
    archivedSessionsRoot: resolveHomePath(process.env.CODEX_ARCHIVED_SESSIONS_ROOT || "~/.codex/archived_sessions"),
    scanArchived: parseBoolean(process.env.CODEX_WATCH_SCAN_ARCHIVED || "false"),
    bootstrapMode,
    ingressToken: normalizeNullable(process.env.CODEX_INGRESS_TOKEN) || undefined,
    signingSecret: normalizeNullable(process.env.CODEX_INGRESS_SIGNING_SECRET) || undefined
  };
}

export function getCodexGlobalWatcherRuntimeStatus(): CodexGlobalWatcherRuntimeStatus {
  return {
    ...codexGlobalWatcherRuntimeStatus,
    autoStartConfigured: resolveCodexGlobalWatcherDefaults().autoStart
  };
}

class CodexGlobalWatcher {
  private readonly statePath: string;
  private readonly state: WatcherState;
  private readonly processedSet: Set<string>;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private resolvedSenderId: string;

  constructor(private readonly args: StartCodexGlobalWatcherArgs) {
    this.statePath = resolve(args.statePath);
    this.state = loadState(this.statePath);
    this.processedSet = new Set(this.state.processedEventKeys);
    this.resolvedSenderId = args.senderId;
  }

  async start() {
    await this.assertGatewayReady();
    this.resolvedSenderId =
      (await resolveFeishuWatcherRecipientOpenId({
        gatewayUrl: this.args.gatewayUrl,
        explicitRecipientOpenId: this.args.recipientOpenId,
        fetchImpl: this.args.fetchImpl
      })) || this.args.senderId;

    if (!this.args.recipientOpenId && this.resolvedSenderId !== this.args.senderId) {
      this.args.logger?.info?.(`[codex-watch] resolved recent feishu open_id=${this.resolvedSenderId}`);
    }

    await this.tick();
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        updateWatcherRuntimeStatus({
          lastError: toErrorMessage(error)
        });
      });
    }, Math.max(this.args.pollIntervalMs, 50));
    this.timer.unref();
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    while (this.busy) {
      await sleep(10);
    }
    this.persistState();
    updateWatcherRuntimeStatus({
      running: false,
      stoppedAt: new Date().toISOString()
    });
  }

  private async tick() {
    if (this.busy) {
      return;
    }
    this.busy = true;
    updateWatcherRuntimeStatus({
      lastTickAt: new Date().toISOString()
    });
    try {
      const files = this.listRolloutFiles();
      if (!this.state.initialized) {
        this.bootstrapState(files);
        return;
      }
      const fileSet = new Set(files);
      let changed = false;

      for (const filePath of files) {
        const posted = await this.processFile(filePath);
        if (posted) {
          changed = true;
        }
      }

      for (const existingFile of Object.keys(this.state.fileOffsets)) {
        if (fileSet.has(existingFile)) {
          continue;
        }
        delete this.state.fileOffsets[existingFile];
        changed = true;
      }

      if (changed) {
        this.persistState();
      }
    } finally {
      this.busy = false;
    }
  }

  private bootstrapState(files: string[]) {
    if (this.args.bootstrapMode === "tail") {
      for (const filePath of files) {
        this.state.fileOffsets[filePath] = safeFileSize(filePath);
      }
    }
    this.state.initialized = true;
    this.persistState();
  }

  private async processFile(filePath: string) {
    const threadId = this.extractThreadId(filePath);
    if (!threadId) {
      return false;
    }

    const currentSize = safeFileSize(filePath);
    const knownOffset = this.state.fileOffsets[filePath] ?? 0;
    const offset = Math.max(0, Math.min(knownOffset, currentSize));
    const content = readFileSync(filePath, "utf8");
    const chunk = Buffer.from(content, "utf8").subarray(offset).toString("utf8");
    if (!chunk.trim()) {
      this.state.fileOffsets[filePath] = Buffer.byteLength(content, "utf8");
      return false;
    }

    const lines = chunk.split("\n");
    let postedAny = false;
    const runtimeByTurnId = new Map<string, TurnRuntimeState>();
    let activeTurnId: string | null = null;
    let latestTokenCount: ReturnType<typeof parseCodexTokenCountSnapshot> | null = null;
    let defaultModelSlug: string | null = null;
    let sessionStartedAt: string | null = null;

    for (const line of lines) {
      const normalized = line.trim();
      if (!normalized) {
        continue;
      }

      const sessionMeta = parseSessionMetaLine(normalized);
      if (sessionMeta) {
        if (sessionMeta.modelSlug) {
          defaultModelSlug = sessionMeta.modelSlug;
        }
        if (sessionMeta.startedAt) {
          sessionStartedAt = pickEarlierTimestamp(sessionStartedAt, sessionMeta.startedAt);
        }
        continue;
      }

      const taskStarted = parseTaskStartedLine(normalized);
      if (taskStarted) {
        activeTurnId = taskStarted.turnId;
        const state = ensureTurnRuntimeState(runtimeByTurnId, taskStarted.turnId);
        state.startedAt = taskStarted.startedAt;
        if (!state.modelSlug && defaultModelSlug) {
          state.modelSlug = defaultModelSlug;
        }
        continue;
      }

      const turnContext = parseTurnContextLine(normalized);
      if (turnContext) {
        activeTurnId = turnContext.turnId;
        const state = ensureTurnRuntimeState(runtimeByTurnId, turnContext.turnId);
        if (turnContext.modelSlug) {
          state.modelSlug = turnContext.modelSlug;
        } else if (!state.modelSlug && defaultModelSlug) {
          state.modelSlug = defaultModelSlug;
        }
        continue;
      }

      const tokenCount = parseTokenCountLine(normalized);
      if (tokenCount) {
        latestTokenCount = tokenCount;
        if (activeTurnId) {
          const state = ensureTurnRuntimeState(runtimeByTurnId, activeTurnId);
          state.tokenUsage = tokenCount.totalUsage?.totalTokens ?? state.tokenUsage;
          state.tokenUsageDetail = tokenCount.totalUsage ?? state.tokenUsageDetail;
          state.lastTokenUsageDetail = tokenCount.lastUsage ?? state.lastTokenUsageDetail;
        }
        continue;
      }

      const parsed = parseTaskCompleteLine(normalized);
      if (!parsed) {
        continue;
      }

      const eventKey = `${threadId}:${parsed.turnId}`;
      if (this.processedSet.has(eventKey)) {
        continue;
      }

      const runtimeState = runtimeByTurnId.get(parsed.turnId) ?? null;
      const durationStart = sessionStartedAt || runtimeState?.startedAt || null;
      const durationMs = resolveDurationMs(durationStart, parsed.timestamp ?? null);
      const tokenUsage = runtimeState?.tokenUsage ?? latestTokenCount?.totalUsage?.totalTokens ?? null;

      const payload = {
        eventId: `codex-watch-complete-${threadId}-${parsed.turnId}`,
        taskId: `codex-turn-${parsed.turnId}`,
        sessionId: this.args.sessionId || threadId,
        toolSessionRef: threadId,
        status: "succeeded",
        summary: `Codex任务完成：${deriveSummary(parsed.lastAgentMessage)}`,
        detail: parsed.lastAgentMessage || "任务已完成（无输出摘要）",
        senderId: this.resolvedSenderId,
        occurredAt: parsed.timestamp || new Date().toISOString(),
        runtimeMeta: {
          durationMs,
          tokenUsage,
          modelSlug: runtimeState?.modelSlug || defaultModelSlug || null,
          tokenUsageDetail: runtimeState?.tokenUsageDetail ?? latestTokenCount?.totalUsage ?? null,
          lastTokenUsageDetail: runtimeState?.lastTokenUsageDetail ?? latestTokenCount?.lastUsage ?? null
        } satisfies CodexRuntimeMeta
      } as const;

      await this.postEvent(payload);
      this.processedSet.add(eventKey);
      this.state.processedEventKeys.push(eventKey);
      this.state.processedEventKeys = trimProcessedKeys(this.state.processedEventKeys);
      postedAny = true;
    }

    this.state.fileOffsets[filePath] = Buffer.byteLength(content, "utf8");
    return postedAny;
  }

  private listRolloutFiles() {
    const roots = [resolve(this.args.sessionsRoot)];
    if (this.args.scanArchived) {
      roots.push(resolve(this.args.archivedSessionsRoot));
    }

    const files: string[] = [];
    for (const root of roots) {
      files.push(...listRolloutFiles(root));
    }
    return files.sort();
  }

  private extractThreadId(filePath: string) {
    const matched = filePath.match(THREAD_ID_PATTERN);
    return matched?.[1]?.toLowerCase() || null;
  }

  private async postEvent(payload: Record<string, unknown>) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (this.args.ingressToken) {
      headers["x-codex-ingress-token"] = this.args.ingressToken;
    }

    const fetchImpl = this.args.fetchImpl ?? fetch;
    try {
      const response = await fetchImpl(`${this.args.gatewayUrl.replace(/\/+$/, "")}/api/codex/events`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`watcher post failed: status=${response.status}; body=${text}`);
      }

      updateWatcherRuntimeStatus({
        lastSuccessfulPostAt: new Date().toISOString(),
        lastPostedEventId: typeof payload.eventId === "string" ? payload.eventId : null,
        lastError: null
      });
    } catch (error) {
      updateWatcherRuntimeStatus({
        lastError: toErrorMessage(error)
      });
      throw error;
    }
  }

  private async assertGatewayReady() {
    const fetchImpl = this.args.fetchImpl ?? fetch;
    const response = await fetchImpl(`${this.args.gatewayUrl.replace(/\/+$/, "")}/health`);
    if (!response.ok) {
      throw new Error(`gateway health check failed: status=${response.status}`);
    }
  }

  private persistState() {
    this.state.updatedAt = new Date().toISOString();
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), "utf8");
  }
}

function listRolloutFiles(root: string) {
  if (!existsSync(root)) {
    return [];
  }

  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Array<import("node:fs").Dirent<string>>;
    try {
      entries = readdirSync(current, { withFileTypes: true }) as Array<import("node:fs").Dirent<string>>;
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryName = String(entry.name);
      const fullPath = resolve(current, entryName);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!entryName.startsWith("rollout-") || !entryName.endsWith(".jsonl")) {
        continue;
      }
      files.push(fullPath);
    }
  }

  return files;
}

function parseTaskCompleteLine(line: string) {
  let record;
  try {
    record = JSON.parse(line) as {
      type?: string;
      timestamp?: string;
      payload?: Record<string, unknown>;
    };
  } catch {
    return null;
  }

  if (record.type !== "event_msg") {
    return null;
  }

  const payload = record.payload || {};
  if (payload.type !== "task_complete") {
    return null;
  }

  const turnId = String(payload.turn_id || payload.turnId || "").trim();
  if (!turnId) {
    return null;
  }

  return {
    turnId,
    lastAgentMessage: String(payload.last_agent_message || payload.lastAgentMessage || "").trim(),
    timestamp: String(record.timestamp || "").trim() || null
  };
}

function parseSessionMetaLine(line: string) {
  let record;
  try {
    record = JSON.parse(line) as {
      type?: string;
      timestamp?: string;
      payload?: Record<string, unknown>;
    };
  } catch {
    return null;
  }

  if (record.type !== "session_meta") {
    return null;
  }

  const payload = record.payload || {};
  return {
    modelSlug: normalizeString(payload.model),
    startedAt: normalizeIsoTimestamp(payload.timestamp) || normalizeIsoTimestamp(record.timestamp)
  };
}

function parseTaskStartedLine(line: string) {
  let record;
  try {
    record = JSON.parse(line) as {
      type?: string;
      timestamp?: string;
      payload?: Record<string, unknown>;
    };
  } catch {
    return null;
  }

  if (record.type !== "event_msg") {
    return null;
  }

  const payload = record.payload || {};
  if (payload.type !== "task_started") {
    return null;
  }

  const turnId = String(payload.turn_id || payload.turnId || "").trim();
  if (!turnId) {
    return null;
  }

  const startedAt = normalizeStartedAt(payload.started_at);
  return {
    turnId,
    startedAt: startedAt || String(record.timestamp || "").trim() || null
  };
}

function parseTurnContextLine(line: string) {
  let record;
  try {
    record = JSON.parse(line) as {
      type?: string;
      payload?: Record<string, unknown>;
    };
  } catch {
    return null;
  }

  if (record.type !== "turn_context") {
    return null;
  }

  const payload = record.payload || {};
  const turnId = String(payload.turn_id || payload.turnId || "").trim();
  if (!turnId) {
    return null;
  }

  return {
    turnId,
    modelSlug: normalizeString(payload.model)
  };
}

function parseTokenCountLine(line: string) {
  let record;
  try {
    record = JSON.parse(line) as {
      type?: string;
      payload?: Record<string, unknown>;
      info?: Record<string, unknown>;
    };
  } catch {
    return null;
  }

  if (record.type !== "token_count") {
    return null;
  }

  const snapshot = parseCodexTokenCountSnapshot(record);
  if (!snapshot) {
    return null;
  }

  return snapshot;
}

function normalizeStartedAt(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return new Date(numeric * 1000).toISOString();
}

function normalizeIsoTimestamp(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return new Date(parsed).toISOString();
}

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveDurationMs(startedAt: string | null | undefined, completedAt: string | null | undefined) {
  if (!startedAt || !completedAt) {
    return null;
  }

  const startedMs = Date.parse(startedAt);
  const completedMs = Date.parse(completedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs) || completedMs < startedMs) {
    return null;
  }

  return completedMs - startedMs;
}

function pickEarlierTimestamp(first: string | null | undefined, second: string | null | undefined) {
  if (first && second) {
    return Date.parse(first) <= Date.parse(second) ? first : second;
  }

  return first || second || null;
}

function ensureTurnRuntimeState(map: Map<string, TurnRuntimeState>, turnId: string) {
  const existing = map.get(turnId);
  if (existing) {
    return existing;
  }

  const created: TurnRuntimeState = {
    startedAt: null,
    modelSlug: null,
    tokenUsage: null,
    tokenUsageDetail: null,
    lastTokenUsageDetail: null
  };
  map.set(turnId, created);
  return created;
}

function deriveSummary(detail: string) {
  const firstLine = detail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => Boolean(line));
  if (!firstLine) {
    return "任务执行结束";
  }
  return firstLine.slice(0, 120);
}

function safeFileSize(filePath: string) {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function loadState(statePath: string): WatcherState {
  if (!existsSync(statePath)) {
    return {
      version: 1,
      initialized: false,
      fileOffsets: {},
      processedEventKeys: [],
      updatedAt: new Date().toISOString()
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<WatcherState>;
    return {
      version: 1,
      initialized: typeof parsed.initialized === "boolean" ? parsed.initialized : true,
      fileOffsets: parsed.fileOffsets || {},
      processedEventKeys: trimProcessedKeys(parsed.processedEventKeys || []),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString()
    };
  } catch {
    return {
      version: 1,
      initialized: false,
      fileOffsets: {},
      processedEventKeys: [],
      updatedAt: new Date().toISOString()
    };
  }
}

function trimProcessedKeys(keys: string[]) {
  if (keys.length <= MAX_PROCESSED_KEYS) {
    return keys;
  }
  return keys.slice(-MAX_PROCESSED_KEYS);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function parseBoolean(raw: string) {
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "y" || value === "on";
}

function parsePositiveInt(raw: string | undefined, fallback: number, min = 1) {
  const value = Number(raw || fallback);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(Math.floor(value), min);
}

function normalizeNullable(value: string | undefined | null) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function resolveHomePath(rawPath: string) {
  const normalized = rawPath.trim();
  const home = process.env.HOME || "";
  if (normalized.startsWith("~/") && home) {
    return resolve(home, normalized.slice(2));
  }
  return resolve(normalized);
}

function updateWatcherRuntimeStatus(patch: Partial<Omit<CodexGlobalWatcherRuntimeStatus, "autoStartConfigured">>) {
  Object.assign(codexGlobalWatcherRuntimeStatus, patch);
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
