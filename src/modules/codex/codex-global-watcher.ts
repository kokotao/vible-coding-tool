/**
 * @description Codex 本地 rollout watcher 模块，扫描 task_complete 事件并回推网关
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-27 10:43
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveFeishuWatcherRecipientOpenId } from "../feishu/feishu-open-id-resolver";

const THREAD_ID_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const MAX_PROCESSED_KEYS = 5000;

type WatcherState = {
  version: 1;
  fileOffsets: Record<string, number>;
  processedEventKeys: string[];
  updatedAt: string;
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

export async function startCodexGlobalWatcher(args: StartCodexGlobalWatcherArgs) {
  const watcher = new CodexGlobalWatcher(args);
  await watcher.start();
  const handle: CodexGlobalWatcherHandle = {
    stop: () => watcher.stop()
  };
  return handle;
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
      console.log(`[codex-watch] resolved recent feishu open_id=${this.resolvedSenderId}`);
    }

    await this.tick();
    this.timer = setInterval(() => {
      void this.tick();
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
  }

  private async tick() {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      const files = this.listRolloutFiles();
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

    for (const line of lines) {
      const normalized = line.trim();
      if (!normalized) {
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

      const payload = {
        eventId: `codex-watch-complete-${threadId}-${parsed.turnId}`,
        taskId: `codex-turn-${parsed.turnId}`,
        sessionId: this.args.sessionId || threadId,
        toolSessionRef: threadId,
        status: "succeeded",
        summary: `Codex任务完成：${deriveSummary(parsed.lastAgentMessage)}`,
        detail: parsed.lastAgentMessage || "任务已完成（无输出摘要）",
        senderId: this.resolvedSenderId,
        occurredAt: parsed.timestamp || new Date().toISOString()
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
    const response = await fetchImpl(`${this.args.gatewayUrl.replace(/\/+$/, "")}/api/codex/events`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`watcher post failed: status=${response.status}; body=${text}`);
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
      fileOffsets: {},
      processedEventKeys: [],
      updatedAt: new Date().toISOString()
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<WatcherState>;
    return {
      version: 1,
      fileOffsets: parsed.fileOffsets || {},
      processedEventKeys: trimProcessedKeys(parsed.processedEventKeys || []),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString()
    };
  } catch {
    return {
      version: 1,
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
