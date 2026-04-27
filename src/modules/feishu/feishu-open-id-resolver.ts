/**
 * @description 飞书 open_id 解析辅助，优先使用显式配置，缺省时回退到最近活跃的 open_id
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-27 15:20
 */
type RecentFeishuOpenIdItem = {
  openId?: string;
};

type RecentFeishuOpenIdsResponse = {
  items?: RecentFeishuOpenIdItem[];
};

type ResolveFeishuWatcherRecipientOpenIdInput = {
  gatewayUrl: string;
  explicitRecipientOpenId: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const FEISHU_OPEN_ID_PATTERN = /^ou_[a-zA-Z0-9_-]+$/;
const DEFAULT_TIMEOUT_MS = 3000;

export async function resolveFeishuWatcherRecipientOpenId(
  input: ResolveFeishuWatcherRecipientOpenIdInput
): Promise<string | null> {
  const explicitRecipientOpenId = input.explicitRecipientOpenId?.trim();
  if (explicitRecipientOpenId) {
    return explicitRecipientOpenId;
  }

  const gatewayUrl = input.gatewayUrl.replace(/\/+$/, "");
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = input.fetchImpl ?? fetch;
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(`${gatewayUrl}/api/feishu/open-ids/recent?limit=1`, {
      signal: abortController.signal
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json().catch(() => null)) as RecentFeishuOpenIdsResponse | null;
    const recentOpenId = normalizeOpenId(payload?.items?.[0]?.openId);
    return recentOpenId;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeOpenId(value: string | undefined) {
  const normalized = (value || "").trim();
  if (!normalized || !FEISHU_OPEN_ID_PATTERN.test(normalized)) {
    return null;
  }

  return normalized;
}
