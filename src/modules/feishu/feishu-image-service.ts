/**
 * @description 飞书图片服务，下载 image_key 对应图片到本地并返回文件路径
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-05-01 23:20
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ConnectorConfigService } from "../connectors/connector-config-service";
import { AppError } from "../../lib/errors";

type FeishuImageServiceDeps = {
  connectorConfigService: ConnectorConfigService;
  fetchImpl?: typeof fetch;
  openBaseUrl?: string;
  imageStoreRoot?: string;
};

const DEFAULT_OPEN_BASE_URL = "https://open.feishu.cn";
const DEFAULT_IMAGE_STORE_ROOT = resolve(process.cwd(), "data", "feishu-images");

export class FeishuImageService {
  private readonly fetchImpl: typeof fetch;
  private readonly openBaseUrl: string;
  private readonly imageStoreRoot: string;
  private tenantTokenCache:
    | {
        token: string;
        expiredAtMs: number;
      }
    | null = null;

  constructor(private readonly deps: FeishuImageServiceDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.openBaseUrl = (deps.openBaseUrl ?? DEFAULT_OPEN_BASE_URL).replace(/\/+$/, "");
    this.imageStoreRoot = deps.imageStoreRoot ?? DEFAULT_IMAGE_STORE_ROOT;
  }

  async downloadImageByKey(input: {
    imageKey: string;
    messageId?: string | null;
  }) {
    const imageKey = String(input.imageKey || "").trim();
    if (!imageKey) {
      throw new AppError("FEISHU_IMAGE_KEY_MISSING", 400, "Feishu image key is required");
    }

    const config = this.deps.connectorConfigService.getConfig("feishu");
    const appId = String(config.appId || "").trim();
    const appSecret = String(config.appSecret || "").trim();
    if (!appId || !appSecret) {
      throw new AppError("FEISHU_IMAGE_CREDENTIALS_MISSING", 400, "Feishu app credentials are not configured");
    }

    const token = await this.fetchTenantAccessToken(appId, appSecret);
    const response = await this.fetchImpl(`${this.openBaseUrl}/open-apis/im/v1/images/${encodeURIComponent(imageKey)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      throw new AppError(
        "FEISHU_IMAGE_DOWNLOAD_FAILED",
        502,
        `Failed to download Feishu image: status=${response.status} body=${responseText || "<empty>"}`
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const extension = this.resolveExtension(contentType);
    const savedPath = this.resolveStoragePath({
      imageKey,
      messageId: input.messageId ?? null,
      extension
    });

    mkdirSync(dirname(savedPath), { recursive: true });
    writeFileSync(savedPath, Buffer.from(arrayBuffer));
    return {
      imageKey,
      savedPath
    };
  }

  private resolveStoragePath(input: {
    imageKey: string;
    messageId: string | null;
    extension: string;
  }) {
    const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const messageToken = (input.messageId || "msg").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 48) || "msg";
    const imageToken = input.imageKey.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 64) || "image";
    const fileName = `${Date.now()}_${messageToken}_${imageToken}${input.extension}`;
    return resolve(this.imageStoreRoot, day, fileName);
  }

  private resolveExtension(contentType: string) {
    if (contentType.includes("image/png")) {
      return ".png";
    }
    if (contentType.includes("image/jpeg") || contentType.includes("image/jpg")) {
      return ".jpg";
    }
    if (contentType.includes("image/webp")) {
      return ".webp";
    }
    if (contentType.includes("image/gif")) {
      return ".gif";
    }
    if (contentType.includes("image/bmp")) {
      return ".bmp";
    }
    return ".bin";
  }

  private async fetchTenantAccessToken(appId: string, appSecret: string) {
    if (this.tenantTokenCache && this.tenantTokenCache.expiredAtMs > Date.now() + 30_000) {
      return this.tenantTokenCache.token;
    }

    const response = await this.fetchImpl(`${this.openBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        app_id: appId,
        app_secret: appSecret
      })
    });

    const payload = (await response.json().catch(() => null)) as
      | {
          code?: number;
          expire?: number;
          tenant_access_token?: string;
        }
      | null;

    const token = String(payload?.tenant_access_token || "").trim();
    if (!response.ok || payload?.code !== 0 || !token) {
      throw new AppError("FEISHU_TOKEN_FETCH_FAILED", 502, "Failed to fetch Feishu tenant access token");
    }

    const expireSeconds = typeof payload.expire === "number" ? payload.expire : 7200;
    this.tenantTokenCache = {
      token,
      expiredAtMs: Date.now() + expireSeconds * 1000
    };
    return token;
  }
}
