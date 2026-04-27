/**
 * @description 定时扫描本机 ~/.codex/sessions 下 rollout 文件，并提供线程解析、项目聚合和聊天内容视图
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-27 11:17
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { AppError } from "../../lib/errors";
import { summarizeText } from "../common/display";

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ROLLOUT_FILE_PATTERN = /^rollout-.*\.jsonl$/i;

type LocalSessionMessageRole = "user" | "assistant" | "tool";

export type LocalCodexSessionMessage = {
  kind: "message" | "tool_call" | "tool_output";
  role: LocalSessionMessageRole;
  content: string;
  name?: string | null;
  callId?: string | null;
  phase?: string | null;
  timestamp?: string | null;
};

type LocalSessionInternalRecord = {
  threadId: string;
  rolloutFileName: string;
  rolloutPath: string;
  projectName: string;
  projectPath: string;
  sessionTitle: string;
  messageCount: number;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  messages: LocalCodexSessionMessage[];
  year: string;
  month: string;
  day: string;
  sizeBytes: number;
  updatedAt: string;
  updatedAtMs: number;
};

type LocalSessionCache = {
  scannedAt: string;
  scannedAtMs: number;
  items: LocalSessionInternalRecord[];
  byThreadId: Map<string, LocalSessionInternalRecord[]>;
};

export type LocalCodexSessionRecord = Omit<LocalSessionInternalRecord, "messages" | "updatedAtMs">;

export type LocalCodexSessionDayGroup = {
  day: string;
  count: number;
  items: LocalCodexSessionRecord[];
};

export type LocalCodexSessionMonthGroup = {
  month: string;
  count: number;
  days: LocalCodexSessionDayGroup[];
};

export type LocalCodexSessionYearGroup = {
  year: string;
  count: number;
  months: LocalCodexSessionMonthGroup[];
};

export type LocalCodexSessionSnapshot = {
  rootPath: string;
  scannedAt: string;
  totalFiles: number;
  totalThreads: number;
  items: LocalCodexSessionRecord[];
  groups: LocalCodexSessionYearGroup[];
};

export type LocalCodexSessionDetail = LocalCodexSessionRecord & {
  messages: LocalCodexSessionMessage[];
};

export type LocalThreadResolveResult =
  | { status: "resolved"; threadId: string; source: "uuid" | "rollout" | "prefix" }
  | { status: "ambiguous"; selector: string; candidates: string[] }
  | { status: "not_found"; selector: string };

export class CodexLocalSessionService {
  private readonly rootPath: string;
  private readonly scanIntervalMs: number;
  private refreshTimer: NodeJS.Timeout | null = null;
  private cache: LocalSessionCache = {
    scannedAt: "",
    scannedAtMs: 0,
    items: [],
    byThreadId: new Map()
  };

  constructor(options: { rootPath: string; scanIntervalMs: number }) {
    this.rootPath = resolveHomePath(options.rootPath);
    this.scanIntervalMs = Math.max(options.scanIntervalMs, 1000);
  }

  start() {
    this.refresh(true);
    if (this.refreshTimer) {
      return;
    }
    this.refreshTimer = setInterval(() => {
      this.refresh(true);
    }, this.scanIntervalMs);
    this.refreshTimer.unref();
  }

  stop() {
    if (!this.refreshTimer) {
      return;
    }
    clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  getSnapshot(input: { limit: number; refresh: boolean }): LocalCodexSessionSnapshot {
    this.refresh(input.refresh);

    const limit = Math.min(Math.max(input.limit, 1), 10000);
    const sliced = this.cache.items.slice(0, limit);
    const publicItems = sliced.map((item) => this.toPublicRecord(item));

    return {
      rootPath: this.rootPath,
      scannedAt: this.cache.scannedAt,
      totalFiles: this.cache.items.length,
      totalThreads: this.cache.byThreadId.size,
      items: publicItems,
      groups: buildGroupsByDate(publicItems)
    };
  }

  getSessionDetail(input: { threadId: string; refresh: boolean }): LocalCodexSessionDetail {
    this.refresh(input.refresh);
    const records = this.cache.byThreadId.get(input.threadId.toLowerCase()) || [];
    const record = records[0];

    if (!record) {
      throw new AppError("CODEX_LOCAL_SESSION_NOT_FOUND", 404, `Local codex session ${input.threadId} not found`);
    }

    return {
      ...this.toPublicRecord(record),
      messages: record.messages
    };
  }

  resolveThreadSelector(selector: string): LocalThreadResolveResult {
    const normalized = selector.trim();
    if (!normalized) {
      return {
        status: "not_found",
        selector
      };
    }

    this.refresh(false);

    const uuid = this.extractThreadId(normalized);
    if (uuid) {
      return {
        status: "resolved",
        threadId: uuid,
        source: "uuid"
      };
    }

    const rolloutName = this.extractRolloutName(normalized);
    if (rolloutName) {
      const rolloutThreadId = this.extractThreadId(rolloutName);
      if (rolloutThreadId) {
        return {
          status: "resolved",
          threadId: rolloutThreadId,
          source: "rollout"
        };
      }

      const matched = this.cache.items.filter((item) => item.rolloutFileName === rolloutName);
      const unique = [...new Set(matched.map((item) => item.threadId))];
      if (unique.length === 1) {
        return {
          status: "resolved",
          threadId: unique[0],
          source: "rollout"
        };
      }
      if (unique.length > 1) {
        return {
          status: "ambiguous",
          selector,
          candidates: unique
        };
      }
    }

    const prefixes = this.extractThreadPrefixes(normalized);
    const matchedThreadIds = new Set<string>();
    for (const prefix of prefixes) {
      for (const threadId of this.cache.byThreadId.keys()) {
        if (threadId.startsWith(prefix)) {
          matchedThreadIds.add(threadId);
        }
      }
    }

    if (matchedThreadIds.size === 1) {
      return {
        status: "resolved",
        threadId: [...matchedThreadIds][0],
        source: "prefix"
      };
    }

    if (matchedThreadIds.size > 1) {
      return {
        status: "ambiguous",
        selector,
        candidates: [...matchedThreadIds].sort()
      };
    }

    return {
      status: "not_found",
      selector
    };
  }

  private refresh(force: boolean) {
    const isExpired = Date.now() - this.cache.scannedAtMs >= this.scanIntervalMs;
    if (!force && this.cache.scannedAtMs > 0 && !isExpired) {
      return;
    }

    const items = this.scanRolloutFiles();
    const byThreadId = new Map<string, LocalSessionInternalRecord[]>();
    for (const item of items) {
      const list = byThreadId.get(item.threadId);
      if (list) {
        list.push(item);
      } else {
        byThreadId.set(item.threadId, [item]);
      }
    }

    const now = new Date().toISOString();
    this.cache = {
      scannedAt: now,
      scannedAtMs: Date.now(),
      items,
      byThreadId
    };
  }

  private scanRolloutFiles() {
    if (!existsSync(this.rootPath)) {
      return [];
    }

    const stack = [this.rootPath];
    const items: LocalSessionInternalRecord[] = [];

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
        const entryPath = resolve(current, entryName);
        if (entry.isDirectory()) {
          stack.push(entryPath);
          continue;
        }

        if (!entry.isFile() || !ROLLOUT_FILE_PATTERN.test(entryName)) {
          continue;
        }

        const threadId = this.extractThreadId(entryName);
        if (!threadId) {
          continue;
        }

        let stats: ReturnType<typeof statSync>;
        try {
          stats = statSync(entryPath);
        } catch {
          continue;
        }

        const parsed = this.parseSessionFile(entryPath);
        const date = deriveDateFromPath(this.rootPath, entryPath, stats.mtime);
        items.push({
          threadId,
          rolloutFileName: basename(entryPath),
          rolloutPath: entryPath,
          projectName: parsed.projectName,
          projectPath: parsed.projectPath,
          sessionTitle: parsed.sessionTitle,
          messageCount: parsed.messageCount,
          firstMessageAt: parsed.firstMessageAt,
          lastMessageAt: parsed.lastMessageAt,
          messages: parsed.messages,
          year: date.year,
          month: date.month,
          day: date.day,
          sizeBytes: stats.size,
          updatedAt: stats.mtime.toISOString(),
          updatedAtMs: stats.mtimeMs
        });
      }
    }

    items.sort((a, b) => {
      if (b.updatedAtMs !== a.updatedAtMs) {
        return b.updatedAtMs - a.updatedAtMs;
      }
      return a.rolloutPath.localeCompare(b.rolloutPath);
    });

    return items;
  }

  private parseSessionFile(filePath: string): {
    projectName: string;
    projectPath: string;
    sessionTitle: string;
    messageCount: number;
    firstMessageAt: string | null;
    lastMessageAt: string | null;
    messages: LocalCodexSessionMessage[];
  } {
    let content = "";
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      content = "";
    }

    const lines = content.split(/\r?\n/);
    const messages: LocalCodexSessionMessage[] = [];
    let projectPath = this.rootPath;
    let projectName = basename(this.rootPath);
    let sessionTitle = basename(filePath).replace(/^rollout-/, "").replace(/\.jsonl$/i, "");
    let firstMessageAt: string | null = null;
    let lastMessageAt: string | null = null;

    for (const line of lines) {
      const normalized = line.trim();
      if (!normalized) {
        continue;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(normalized) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (parsed.type === "session_meta") {
        const payload = parsed.payload as Record<string, unknown> | undefined;
        const cwd = typeof payload?.cwd === "string" ? payload.cwd.trim() : "";
        const timestamp = getTimestampValue(payload?.timestamp) || getTimestampValue(parsed.timestamp);
        if (cwd) {
          projectPath = cwd;
          projectName = basename(cwd.replace(/[\\/]+$/, "")) || projectName;
        }
        if (timestamp && !firstMessageAt) {
          firstMessageAt = timestamp;
        }
        continue;
      }

      if (parsed.type !== "response_item") {
        continue;
      }

      const message = normalizeResponseItem(parsed.payload as Record<string, unknown> | undefined, getTimestampValue(parsed.timestamp));
      if (!message) {
        continue;
      }

      messages.push(message);
      if (!firstMessageAt && message.timestamp) {
        firstMessageAt = message.timestamp;
      }
      if (message.timestamp) {
        lastMessageAt = message.timestamp;
      }
    }

    const derivedTitle = buildSessionTitle(messages);
    sessionTitle = derivedTitle || projectName || sessionTitle;

    return {
      projectName,
      projectPath,
      sessionTitle: summarizeText(sessionTitle, 72) || projectName,
      messageCount: messages.length,
      firstMessageAt,
      lastMessageAt,
      messages
    };
  }

  private toPublicRecord(item: LocalSessionInternalRecord): LocalCodexSessionRecord {
    return {
      threadId: item.threadId,
      rolloutFileName: item.rolloutFileName,
      rolloutPath: item.rolloutPath,
      projectName: item.projectName,
      projectPath: item.projectPath,
      sessionTitle: item.sessionTitle,
      messageCount: item.messageCount,
      firstMessageAt: item.firstMessageAt,
      lastMessageAt: item.lastMessageAt,
      year: item.year,
      month: item.month,
      day: item.day,
      sizeBytes: item.sizeBytes,
      updatedAt: item.updatedAt
    };
  }

  private extractThreadId(value: string) {
    const matched = value.match(UUID_PATTERN);
    return matched?.[0]?.toLowerCase() || null;
  }

  private extractRolloutName(selector: string) {
    const normalized = selector.trim();
    const base = basename(normalized);
    if (ROLLOUT_FILE_PATTERN.test(base)) {
      return base;
    }

    const matched = normalized.match(/rollout-[^\s/\\]+\.jsonl/i);
    if (!matched) {
      return null;
    }

    return basename(matched[0]);
  }

  private extractThreadPrefixes(selector: string) {
    const prefixes = new Set<string>();
    const normalized = selector.trim().toLowerCase();
    const directMatched = normalized.match(/^[0-9a-f]{6,}$/);
    if (directMatched) {
      prefixes.add(directMatched[0]);
    }

    const titleMatched = normalized.match(/^([0-9a-f]{6,})[-_]/);
    if (titleMatched) {
      prefixes.add(titleMatched[1]);
    }

    return [...prefixes];
  }
}

function normalizeResponseItem(
  payload: Record<string, unknown> | undefined,
  timestamp: string | null
): LocalCodexSessionMessage | null {
  if (!payload) {
    return null;
  }

  const itemType = String(payload.type || "").toLowerCase();
  if (itemType === "reasoning") {
    return null;
  }

  if (itemType === "function_call" || itemType === "custom_tool_call") {
    const content = formatToolPayload(payload.arguments);
    if (!content) {
      return null;
    }

    return {
      kind: "tool_call",
      role: "assistant",
      content,
      name: stringValue(payload.name),
      callId: stringValue(payload.call_id),
      phase: stringValue(payload.phase),
      timestamp
    };
  }

  if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
    const content = formatToolPayload(payload.output);
    if (!content) {
      return null;
    }

    return {
      kind: "tool_output",
      role: "tool",
      content,
      callId: stringValue(payload.call_id),
      timestamp
    };
  }

  const role = normalizeRole(payload.role);
  const content = extractPlainText(payload.content || payload.text || payload.output || payload.value);
  if (!content) {
    return null;
  }

  return {
    kind: "message",
    role,
    content,
    phase: stringValue(payload.phase),
    timestamp
  };
}

function normalizeRole(value: unknown): LocalSessionMessageRole {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "user" || normalized === "tool") {
    return normalized;
  }

  return "assistant";
}

function buildSessionTitle(messages: LocalCodexSessionMessage[]) {
  const firstUserMessage = messages.find((message) => message.kind === "message" && message.role === "user");
  if (firstUserMessage?.content) {
    return summarizeText(firstUserMessage.content, 72) || firstUserMessage.content;
  }

  const firstAssistantMessage = messages.find((message) => message.kind === "message" && message.role === "assistant");
  if (firstAssistantMessage?.content) {
    return summarizeText(firstAssistantMessage.content, 72) || firstAssistantMessage.content;
  }

  const firstToolCall = messages.find((message) => message.kind === "tool_call");
  if (firstToolCall?.content) {
    return summarizeText(firstToolCall.content, 72) || firstToolCall.content;
  }

  return "";
}

function extractPlainText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value.map((item) => extractPlainText(item)).filter(Boolean).join("\n");
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text.trim();
  }
  if (typeof record.content === "string") {
    return record.content.trim();
  }
  if (Array.isArray(record.content)) {
    return extractPlainText(record.content);
  }
  if (typeof record.value === "string") {
    return record.value.trim();
  }

  return "";
}

function formatToolPayload(value: unknown) {
  const text = extractPlainText(value);
  if (text) {
    return text;
  }

  if (value === null || value === undefined) {
    return "";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stringValue(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  return null;
}

function getTimestampValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function buildGroupsByDate(items: LocalCodexSessionRecord[]): LocalCodexSessionYearGroup[] {
  const yearMap = new Map<string, Map<string, Map<string, LocalCodexSessionRecord[]>>>();

  for (const item of items) {
    let monthMap = yearMap.get(item.year);
    if (!monthMap) {
      monthMap = new Map<string, Map<string, LocalCodexSessionRecord[]>>();
      yearMap.set(item.year, monthMap);
    }

    let dayMap = monthMap.get(item.month);
    if (!dayMap) {
      dayMap = new Map<string, LocalCodexSessionRecord[]>();
      monthMap.set(item.month, dayMap);
    }

    let list = dayMap.get(item.day);
    if (!list) {
      list = [];
      dayMap.set(item.day, list);
    }
    list.push(item);
  }

  return [...yearMap.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([year, monthMap]) => {
      const months = [...monthMap.entries()]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([month, dayMap]) => {
          const days = [...dayMap.entries()]
            .sort((a, b) => b[0].localeCompare(a[0]))
            .map(([day, dayItems]) => ({
              day,
              count: dayItems.length,
              items: dayItems
            }));

          return {
            month,
            count: days.reduce((sum, day) => sum + day.count, 0),
            days
          };
        });

      return {
        year,
        count: months.reduce((sum, month) => sum + month.count, 0),
        months
      };
    });
}

function deriveDateFromPath(rootPath: string, filePath: string, fallbackDate: Date) {
  const normalizedRelative = relative(rootPath, filePath).split(/[\\/]/).filter(Boolean);
  if (normalizedRelative.length >= 4) {
    const [year, month, day] = normalizedRelative;
    if (/^\d{4}$/.test(year) && /^\d{2}$/.test(month) && /^\d{2}$/.test(day)) {
      return { year, month, day };
    }
  }

  const year = String(fallbackDate.getFullYear());
  const month = String(fallbackDate.getMonth() + 1).padStart(2, "0");
  const day = String(fallbackDate.getDate()).padStart(2, "0");
  return { year, month, day };
}

function resolveHomePath(pathValue: string) {
  const value = (pathValue || "").trim();
  const home = process.env.HOME || "";
  if (value.startsWith("~/") && home) {
    return resolve(home, value.slice(2));
  }
  return resolve(value || "~/.codex/sessions");
}
