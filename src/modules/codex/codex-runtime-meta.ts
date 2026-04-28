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
  lastTokenUsageDetail?: CodexTokenUsageBreakdown | null;
} | null;

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

export function parseCodexTokenUsageBreakdown(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const usage = {
    inputTokens: normalizeTokenCount(record.input_tokens),
    cachedInputTokens: normalizeTokenCount(record.cached_input_tokens),
    outputTokens: normalizeTokenCount(record.output_tokens),
    reasoningOutputTokens: normalizeTokenCount(record.reasoning_output_tokens),
    totalTokens: normalizeTokenCount(record.total_tokens)
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

function normalizeTokenCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(Math.round(value), 0) : null;
}
