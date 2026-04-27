/**
 * @description 飞书身份服务，负责 open_id 自动解析与手动姓名绑定
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-27 20:10
 */
import { ConnectorConfigService } from "../connectors/connector-config-service";
import { AppError } from "../../lib/errors";
import {
  FeishuIdentityRepository,
  type FeishuIdentityRecord
} from "../../storage/repositories/feishu-identity-repository";

type FeishuIdentityServiceDeps = {
  connectorConfigService: ConnectorConfigService;
  identityRepository: FeishuIdentityRepository;
  fetchImpl?: typeof fetch;
  openBaseUrl?: string;
};

type TenantTokenResult =
  | {
      ok: true;
      token: string;
    }
  | {
      ok: false;
      token: null;
    };

type FeishuUserProfileResponse = {
  code?: number;
  data?: {
    user?: {
      name?: string;
      en_name?: string;
      nickname?: string;
    };
  };
};

const DEFAULT_OPEN_BASE_URL = "https://open.feishu.cn";
const FEISHU_OPEN_ID_PATTERN = /^ou_[a-zA-Z0-9_-]+$/;

export class FeishuIdentityService {
  private readonly openBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private tenantTokenCache:
    | {
        token: string;
        expiredAtMs: number;
      }
    | null = null;

  constructor(private readonly deps: FeishuIdentityServiceDeps) {
    this.openBaseUrl = (deps.openBaseUrl ?? DEFAULT_OPEN_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  getCachedIdentity(openId: string) {
    const normalized = this.normalizeOpenId(openId);
    if (!normalized) {
      return null;
    }

    return this.deps.identityRepository.findByOpenId(normalized) ?? null;
  }

  listRecentBindings(limit = 20) {
    const normalizedLimit = Math.min(Math.max(limit, 1), 100);
    return this.deps.identityRepository.listRecent(normalizedLimit);
  }

  getDisplayLabel(openId: string) {
    const normalized = this.normalizeOpenId(openId);
    if (!normalized) {
      return "";
    }

    const identity = this.getCachedIdentity(normalized);
    if (!identity?.displayName) {
      return normalized;
    }

    return `${identity.displayName} (${normalized})`;
  }

  async ensureAutoIdentity(openId: string): Promise<FeishuIdentityRecord | null> {
    const normalized = this.normalizeOpenId(openId);
    if (!normalized) {
      return null;
    }

    const existing = this.deps.identityRepository.findByOpenId(normalized);
    if (existing?.bindingSource === "manual") {
      return existing;
    }

    if (existing?.displayName) {
      return existing;
    }

    const config = this.deps.connectorConfigService.getConfig("feishu");
    const appId = config.appId.trim();
    const appSecret = config.appSecret.trim();

    if (!appId || !appSecret) {
      return null;
    }

    const token = await this.fetchTenantAccessToken(appId, appSecret);
    if (!token.ok) {
      return null;
    }

    const displayName = await this.fetchUserDisplayName(normalized, token.token);
    if (!displayName) {
      return null;
    }

    return this.deps.identityRepository.upsertAuto({
      openId: normalized,
      displayName,
      updatedAt: new Date().toISOString()
    }) ?? null;
  }

  bindDisplayName(input: { openId: string; displayName: string; boundBy?: string | null }) {
    const openId = this.normalizeOpenId(input.openId);
    if (!openId) {
      throw new AppError("FEISHU_OPEN_ID_INVALID", 400, "Feishu open_id format is invalid");
    }

    const displayName = this.normalizeDisplayName(input.displayName);
    if (!displayName) {
      throw new AppError("FEISHU_DISPLAY_NAME_REQUIRED", 400, "Display name is required");
    }

    return this.deps.identityRepository.upsertManual({
      openId,
      displayName,
      boundBy: input.boundBy ?? null,
      updatedAt: new Date().toISOString()
    }) ?? null;
  }

  async resolveAndStoreAutoIdentity(openId: string) {
    return this.ensureAutoIdentity(openId);
  }

  private async fetchUserDisplayName(openId: string, tenantToken: string) {
    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      abortController.abort();
    }, 6000);

    try {
      const response = await this.fetchImpl(
        `${this.openBaseUrl}/open-apis/contact/v3/users/${encodeURIComponent(openId)}?user_id_type=open_id`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${tenantToken}`
          },
          signal: abortController.signal
        }
      );

      const payload = (await response.json().catch(() => null)) as FeishuUserProfileResponse | null;
      const user = payload?.data?.user;
      const displayName = this.normalizeDisplayName(user?.nickname || user?.name || user?.en_name);
      return displayName || null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchTenantAccessToken(appId: string, appSecret: string): Promise<TenantTokenResult> {
    if (this.tenantTokenCache && this.tenantTokenCache.expiredAtMs > Date.now() + 30_000) {
      return {
        ok: true,
        token: this.tenantTokenCache.token
      };
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      abortController.abort();
    }, 6000);

    try {
      const response = await this.fetchImpl(`${this.openBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          app_id: appId,
          app_secret: appSecret
        }),
        signal: abortController.signal
      });

      const payload = (await response.json().catch(() => null)) as
        | {
            code?: number;
            expire?: number;
            tenant_access_token?: string;
          }
        | null;

      const token = payload?.tenant_access_token?.trim();
      if (!response.ok || payload?.code !== 0 || !token) {
        return {
          ok: false,
          token: null
        };
      }

      const expireSeconds = typeof payload.expire === "number" ? payload.expire : 7200;
      this.tenantTokenCache = {
        token,
        expiredAtMs: Date.now() + expireSeconds * 1000
      };

      return {
        ok: true,
        token
      };
    } catch {
      return {
        ok: false,
        token: null
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private normalizeOpenId(value: string) {
    const normalized = (value || "").trim();
    if (!normalized || !FEISHU_OPEN_ID_PATTERN.test(normalized)) {
      return null;
    }

    return normalized;
  }

  private normalizeDisplayName(value: string | undefined) {
    const normalized = (value || "").trim();
    return normalized || null;
  }
}
