/**
 * @description 监听本机 Codex rollout 日志中的 task_complete 事件，并自动上报到网关触发飞书回推
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-26 23:10
 */
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type WatcherArgs = {
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
};

type WatcherState = {
  version: 1;
  initialized: boolean;
  fileOffsets: Record<string, number>;
  processedEventKeys: string[];
  updatedAt: string;
};

type CodexEventPayload = {
  eventId: string;
  taskId: string;
  sessionId: string;
  toolSessionRef: string;
  status: "succeeded";
  summary: string;
  detail: string;
  senderId: string;
  occurredAt: string;
};

const MAX_PROCESSED_EVENT_KEYS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 3000;
const HOME_DIR = process.env.HOME || "";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await assertGatewayReady(args.gatewayUrl);

  const state = loadState(args.statePath);
  const partialBuffers = new Map<string, string>();
  const processedSet = new Set(state.processedEventKeys);

  await bootstrapStateIfNeeded(args, state);
  saveState(args.statePath, state);

  console.log(
    `[codex-watch] start poll=${args.pollIntervalMs}ms gateway=${args.gatewayUrl} session=${
      args.sessionId || "<thread-id>"
    }`
  );

  let stopped = false;
  const shutdown = (signal: string) => {
    if (stopped) {
      return;
    }
    stopped = true;
    console.log(`[codex-watch] received ${signal}, shutting down...`);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  while (!stopped) {
    try {
      const files = listScanFiles(args);
      const fileSet = new Set(files);
      let stateChanged = false;

      for (const filePath of files) {
        const changed = await processFile({
          filePath,
          args,
          state,
          partialBuffers,
          processedSet
        });
        if (changed) {
          stateChanged = true;
        }
      }

      for (const knownFile of Object.keys(state.fileOffsets)) {
        if (fileSet.has(knownFile)) {
          continue;
        }
        delete state.fileOffsets[knownFile];
        partialBuffers.delete(knownFile);
        stateChanged = true;
      }

      if (stateChanged) {
        state.processedEventKeys = trimProcessedKeys(state.processedEventKeys);
        state.updatedAt = new Date().toISOString();
        saveState(args.statePath, state);
      }
    } catch (error) {
      console.error("[codex-watch] loop error:", error instanceof Error ? error.message : String(error));
    }

    await sleep(args.pollIntervalMs);
  }
}

async function bootstrapStateIfNeeded(args: WatcherArgs, state: WatcherState) {
  if (state.initialized) {
    return;
  }

  const files = listScanFiles(args);
  for (const filePath of files) {
    const size = safeFileSize(filePath);
    state.fileOffsets[filePath] = args.bootstrapMode === "tail" ? size : 0;
  }

  state.initialized = true;
  state.updatedAt = new Date().toISOString();
  console.log(
    `[codex-watch] bootstrap mode=${args.bootstrapMode} files=${files.length} state=${resolve(args.statePath)}`
  );
}

async function processFile(input: {
  filePath: string;
  args: WatcherArgs;
  state: WatcherState;
  partialBuffers: Map<string, string>;
  processedSet: Set<string>;
}) {
  const { filePath, args, state, partialBuffers, processedSet } = input;
  const size = safeFileSize(filePath);
  const knownOffset = state.fileOffsets[filePath];

  if (knownOffset === undefined) {
    state.fileOffsets[filePath] = 0;
  }

  let offset = state.fileOffsets[filePath] ?? 0;
  if (size < offset) {
    offset = 0;
    partialBuffers.delete(filePath);
  }

  if (size === offset) {
    return false;
  }

  const chunk = await readFileChunk(filePath, offset, size);
  let text = `${partialBuffers.get(filePath) || ""}${chunk}`;
  const hasTrailingNewline = text.endsWith("\n");
  const lines = text.split("\n");

  if (!hasTrailingNewline) {
    const tail = lines.pop() || "";
    partialBuffers.set(filePath, tail);
  } else {
    partialBuffers.delete(filePath);
  }

  for (const line of lines) {
    const event = parseTaskCompleteEvent(line, filePath, args);
    if (!event) {
      continue;
    }

    if (processedSet.has(event.eventKey)) {
      continue;
    }

    const result = await postEvent(args, event.payload);
    console.log(
      `[codex-watch] posted turn=${event.turnId} thread=${event.threadId} status=${event.payload.status} notify=${result}`
    );

    processedSet.add(event.eventKey);
    state.processedEventKeys.push(event.eventKey);
  }

  state.fileOffsets[filePath] = size;
  return true;
}

function parseTaskCompleteEvent(line: string, filePath: string, args: WatcherArgs) {
  if (!line.trim()) {
    return null;
  }

  let record: {
    type?: string;
    timestamp?: string;
    payload?: Record<string, unknown>;
  };
  try {
    record = JSON.parse(line);
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

  const turnId = String(payload.turn_id || "").trim();
  if (!turnId) {
    return null;
  }

  const threadId = extractThreadId(filePath);
  if (!threadId) {
    return null;
  }

  const summarySource = String(payload.last_agent_message || "").trim();
  const summaryTitle = deriveSummaryTitle(summarySource);
  const summary = `Codex任务完成：${summaryTitle}`;
  const detail = sanitizeDetail(summarySource || "任务已完成（无输出摘要）", 1800);
  const sessionId = args.sessionId || threadId;
  const senderId = args.recipientOpenId || args.senderId;
  const occurredAt =
    String(record.timestamp || "").trim() || new Date(Number(payload.completed_at || 0) * 1000 || Date.now()).toISOString();

  const eventPayload: CodexEventPayload = {
    eventId: `codex-watch-complete-${threadId}-${turnId}`,
    taskId: `codex-turn-${turnId}`,
    sessionId,
    toolSessionRef: threadId,
    status: "succeeded",
    summary,
    detail,
    senderId,
    occurredAt
  };

  return {
    eventKey: `${threadId}:${turnId}`,
    threadId,
    turnId,
    payload: eventPayload
  };
}

function deriveSummaryTitle(value: string) {
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => Boolean(line));

  if (!firstLine) {
    return "任务执行结束";
  }

  return firstLine.slice(0, 120);
}

function parseArgs(argv: string[]): WatcherArgs {
  const optionMap = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new Error(`invalid option token: ${token}`);
    }

    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for option --${key}`);
    }
    optionMap.set(key, value);
    i += 1;
  }

  const gatewayUrl = (optionMap.get("gateway") || process.env.GATEWAY_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
  const statePath = optionMap.get("state") || process.env.CODEX_WATCH_STATE_PATH || "./data/codex-watcher-state.json";
  const pollIntervalMs = Number(optionMap.get("pollMs") || process.env.CODEX_WATCH_POLL_MS || DEFAULT_POLL_INTERVAL_MS);
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 500) {
    throw new Error("pollMs must be >= 500");
  }

  const bootstrapModeRaw = (optionMap.get("bootstrap") || process.env.CODEX_WATCH_BOOTSTRAP || "tail").toLowerCase();
  if (bootstrapModeRaw !== "tail" && bootstrapModeRaw !== "replay") {
    throw new Error("bootstrap must be one of: tail, replay");
  }

  const sessionId = (optionMap.get("session") || process.env.CODEX_WATCH_SESSION_ID || "").trim() || null;
  const recipientOpenId = (optionMap.get("recipientOpenId") || process.env.CODEX_WATCH_RECIPIENT_OPEN_ID || "").trim() || null;
  const senderId = (optionMap.get("sender") || process.env.CODEX_WATCH_SENDER_ID || "codex_global_watcher").trim();
  const scanArchived = parseBoolean(optionMap.get("scanArchived") || process.env.CODEX_WATCH_SCAN_ARCHIVED || "false");
  const sessionsRoot = resolvePath(
    optionMap.get("sessionsRoot") || process.env.CODEX_SESSIONS_ROOT || "~/.codex/sessions"
  );
  const archivedSessionsRoot = resolvePath(
    optionMap.get("archivedRoot") || process.env.CODEX_ARCHIVED_SESSIONS_ROOT || "~/.codex/archived_sessions"
  );

  if (!senderId && !recipientOpenId) {
    throw new Error("sender must not be empty");
  }

  return {
    gatewayUrl,
    statePath,
    pollIntervalMs,
    sessionId,
    senderId,
    recipientOpenId,
    sessionsRoot,
    archivedSessionsRoot,
    scanArchived,
    bootstrapMode: bootstrapModeRaw,
    ingressToken: optionMap.get("token") || process.env.CODEX_INGRESS_TOKEN,
    signingSecret: optionMap.get("signingSecret") || process.env.CODEX_INGRESS_SIGNING_SECRET
  };
}

function listScanFiles(args: WatcherArgs) {
  const roots = [args.sessionsRoot];
  if (args.scanArchived) {
    roots.push(args.archivedSessionsRoot);
  }

  const files: string[] = [];
  for (const root of roots) {
    files.push(...listRolloutFiles(root));
  }
  return files.sort();
}

function listRolloutFiles(root: string) {
  if (!existsSync(root)) {
    return [];
  }

  const files: string[] = [];
  const stack: string[] = [root];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const filePath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(filePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (!entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      files.push(filePath);
    }
  }

  return files;
}

function extractThreadId(filePath: string) {
  const matched = filePath.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return matched?.[1] || null;
}

function loadState(statePath: string): WatcherState {
  const resolvedPath = resolve(statePath);
  if (!existsSync(resolvedPath)) {
    return {
      version: 1,
      initialized: false,
      fileOffsets: {},
      processedEventKeys: [],
      updatedAt: new Date().toISOString()
    };
  }

  try {
    const raw = readFileSync(resolvedPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<WatcherState>;
    return {
      version: 1,
      initialized: Boolean(parsed.initialized),
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

function saveState(statePath: string, state: WatcherState) {
  const resolvedPath = resolve(statePath);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, JSON.stringify(state, null, 2), "utf8");
}

function trimProcessedKeys(keys: string[]) {
  if (keys.length <= MAX_PROCESSED_EVENT_KEYS) {
    return keys;
  }
  return keys.slice(-MAX_PROCESSED_EVENT_KEYS);
}

async function readFileChunk(filePath: string, start: number, endExclusive: number) {
  const length = endExclusive - start;
  if (length <= 0) {
    return "";
  }

  const fd = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await fd.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fd.close();
  }
}

async function postEvent(args: WatcherArgs, payload: CodexEventPayload) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };

  if (args.ingressToken) {
    headers["x-codex-ingress-token"] = args.ingressToken;
  }
  if (args.signingSecret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomUUID().replaceAll("-", "");
    const signature = createHmac("sha256", args.signingSecret)
      .update(`${timestamp}.${nonce}.${body}`)
      .digest("hex");
    headers["x-codex-ingress-timestamp"] = timestamp;
    headers["x-codex-ingress-nonce"] = nonce;
    headers["x-codex-ingress-signature"] = signature;
  }

  const response = await fetch(`${args.gatewayUrl}/api/codex/events`, {
    method: "POST",
    headers,
    body
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`event post failed: status=${response.status}, body=${text}`);
  }
  return text;
}

async function assertGatewayReady(gatewayUrl: string) {
  const response = await fetch(`${gatewayUrl}/health`);
  if (!response.ok) {
    throw new Error(`gateway health check failed: status=${response.status}`);
  }
}

function safeFileSize(filePath: string) {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function resolvePath(rawPath: string) {
  if (rawPath.startsWith("~/") && HOME_DIR) {
    return resolve(HOME_DIR, rawPath.slice(2));
  }
  return resolve(rawPath);
}

function parseBoolean(raw: string) {
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "y" || value === "on";
}

function sanitizeDetail(value: string, maxLength: number) {
  const cleaned = value.replace(/\u0000/g, "").trim();
  if (!cleaned) {
    return "";
  }

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  return cleaned.slice(0, maxLength);
}

function sleep(ms: number) {
  return new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

void main().catch((error) => {
  console.error("[codex-watch] fatal:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
