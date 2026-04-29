/**
 * @description Codex 运行态与 token 统计辅助类型及解析格式化工具
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-28 17:40
 */
export type CodexTokenUsageBreakdown = {
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
  reasoningOutputTokens?: number | null;
  totalTokens?: number | null;
};

export type CodexTokenCountSnapshot = {
  totalUsage: CodexTokenUsageBreakdown | null;
  lastUsage: CodexTokenUsageBreakdown | null;
};

export type CodexRuntimeMeta = {
  durationMs?: number | null;
  tokenUsage?: number | null;
  modelSlug?: string | null;
  tokenUsageDetail?: CodexTokenUsageBreakdown | null;
  tokenUsageSource?: "delta" | "last_usage" | "cumulative_fallback" | null;
  cumulativeTokenUsageDetail?: CodexTokenUsageBreakdown | null;
  baselineTokenUsageDetail?: CodexTokenUsageBreakdown | null;
  lastTokenUsageDetail?: CodexTokenUsageBreakdown | null;
} | null;

type TokenSnapshotRecord = {
  type?: string;
  payload?: Record<string, unknown>;
  info?: Record<string, unknown>;
  usage?: Record<string, unknown>;
};

export function parseCodexTokenCountSnapshot(record: {
  payload?: Record<string, unknown>;
  info?: Record<string, unknown>;
} | null | undefined) {
  const source = record?.payload || record?.info || {};
  const totalUsage = parseCodexTokenUsageBreakdown(source.total_token_usage);
  const lastUsage = parseCodexTokenUsageBreakdown(source.last_token_usage);

  if (!totalUsage && !lastUsage) {
    return null;
  }

  return {
    totalUsage,
    lastUsage
  } satisfies CodexTokenCountSnapshot;
}

export function parseCodexTokenCountSnapshotFromEventRecord(record: TokenSnapshotRecord | null | undefined) {
  if (!record || typeof record !== "object") {
    return null;
  }

  if (record.type === "token_count") {
    return parseCodexTokenCountSnapshot(record);
  }

  if (record.type === "event_msg" && record.payload && typeof record.payload === "object") {
    const payloadType = String((record.payload as Record<string, unknown>).type || "").trim();
    if (payloadType === "token_count") {
      return parseCodexTokenCountSnapshot(record.payload as { payload?: Record<string, unknown>; info?: Record<string, unknown> });
    }
    if (payloadType === "turn.completed") {
      return parseCodexTurnCompletedUsageSnapshot(record.payload as TokenSnapshotRecord);
    }
  }

  if (record.type === "turn.completed") {
    return parseCodexTurnCompletedUsageSnapshot(record);
  }

  return null;
}

export function parseCodexTokenUsageBreakdown(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const inputTokens = normalizeTokenCount(record.input_tokens ?? record.inputTokens);
  const cachedInputTokens = normalizeTokenCount(record.cached_input_tokens ?? record.cachedInputTokens);
  const outputTokens = normalizeTokenCount(record.output_tokens ?? record.outputTokens);
  const reasoningOutputTokens = normalizeTokenCount(record.reasoning_output_tokens ?? record.reasoningOutputTokens);
  const explicitTotalTokens = normalizeTokenCount(record.total_tokens ?? record.totalTokens);
  const inferredTotalTokens =
    explicitTotalTokens === null && inputTokens !== null && outputTokens !== null
      ? inputTokens + outputTokens
      : null;
  const usage = {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: explicitTotalTokens ?? inferredTotalTokens
  } satisfies CodexTokenUsageBreakdown;

  if (
    usage.inputTokens === null &&
    usage.cachedInputTokens === null &&
    usage.outputTokens === null &&
    usage.reasoningOutputTokens === null &&
    usage.totalTokens === null
  ) {
    return null;
  }

  return usage;
}

export function formatCodexTokenUsageBreakdown(
  usage: CodexTokenUsageBreakdown | null,
  formatNumber: (value: number | null | undefined) => string
) {
  if (!usage) {
    return null;
  }

  const hasAnyValue =
    usage.inputTokens !== null && usage.inputTokens !== undefined ||
    usage.cachedInputTokens !== null && usage.cachedInputTokens !== undefined ||
    usage.outputTokens !== null && usage.outputTokens !== undefined ||
    usage.reasoningOutputTokens !== null && usage.reasoningOutputTokens !== undefined ||
    usage.totalTokens !== null && usage.totalTokens !== undefined;

  if (!hasAnyValue) {
    return null;
  }

  return [
    `input ${formatNumber(usage.inputTokens)}`,
    `cached_input ${formatNumber(usage.cachedInputTokens)}`,
    `output ${formatNumber(usage.outputTokens)}`,
    `reasoning_output ${formatNumber(usage.reasoningOutputTokens)}`,
    `total ${formatNumber(usage.totalTokens)}`
  ].join(" / ");
}

export function resolveCodexTaskTokenUsage(input: {
  baselineUsage?: CodexTokenUsageBreakdown | null;
  totalUsage?: CodexTokenUsageBreakdown | null;
  lastUsage?: CodexTokenUsageBreakdown | null;
}) {
  const diff = subtractCodexTokenUsageBreakdown(input.totalUsage ?? null, input.baselineUsage ?? null);
  if (diff) {
    return {
      usage: diff,
      source: "delta"
    } as const;
  }

  if (input.lastUsage) {
    return {
      usage: input.lastUsage,
      source: "last_usage"
    } as const;
  }

  if (input.totalUsage) {
    return {
      usage: input.totalUsage,
      source: "cumulative_fallback"
    } as const;
  }

  return null;
}

export function subtractCodexTokenUsageBreakdown(
  after: CodexTokenUsageBreakdown | null,
  before: CodexTokenUsageBreakdown | null
) {
  if (!after || !before) {
    return null;
  }

  const usage = {
    inputTokens: subtractTokenCount(after.inputTokens, before.inputTokens),
    cachedInputTokens: subtractTokenCount(after.cachedInputTokens, before.cachedInputTokens),
    outputTokens: subtractTokenCount(after.outputTokens, before.outputTokens),
    reasoningOutputTokens: subtractTokenCount(after.reasoningOutputTokens, before.reasoningOutputTokens),
    totalTokens: subtractTokenCount(after.totalTokens, before.totalTokens)
  } satisfies CodexTokenUsageBreakdown;

  if (
    usage.inputTokens === null &&
    usage.cachedInputTokens === null &&
    usage.outputTokens === null &&
    usage.reasoningOutputTokens === null &&
    usage.totalTokens === null
  ) {
    return null;
  }

  return usage;
}

function normalizeTokenCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(Math.round(value), 0) : null;
}

function subtractTokenCount(after: number | null | undefined, before: number | null | undefined) {
  if (typeof after !== "number" || typeof before !== "number") {
    return null;
  }

  if (!Number.isFinite(after) || !Number.isFinite(before) || after < before) {
    return null;
  }

  return Math.max(Math.round(after - before), 0);
}

function parseCodexTurnCompletedUsageSnapshot(record: TokenSnapshotRecord | null | undefined) {
  const usageSource = record?.usage || record?.payload?.usage;
  const usage = parseCodexTokenUsageBreakdown(usageSource);
  if (!usage) {
    return null;
  }

  return {
    totalUsage: usage,
    lastUsage: usage
  } satisfies CodexTokenCountSnapshot;
}
