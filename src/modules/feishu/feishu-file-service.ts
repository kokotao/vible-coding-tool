/**
 * @description 飞书文件服务，下载 file_key 对应文件到本地并返回文件路径
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-05-02 00:12
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ConnectorConfigService } from "../connectors/connector-config-service";
import { AppError } from "../../lib/errors";

type FeishuFileServiceDeps = {
  connectorConfigService: ConnectorConfigService;
  fetchImpl?: typeof fetch;
  openBaseUrl?: string;
  fileStoreRoot?: string;
};

const DEFAULT_OPEN_BASE_URL = "https://open.feishu.cn";
const DEFAULT_FILE_STORE_ROOT = resolve(process.cwd(), "data", "feishu-files");

export class FeishuFileService {
  private readonly fetchImpl: typeof fetch;
  private readonly openBaseUrl: string;
  private readonly fileStoreRoot: string;
  private tenantTokenCache:
    | {
        token: string;
        expiredAtMs: number;
      }
    | null = null;

  constructor(private readonly deps: FeishuFileServiceDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.openBaseUrl = (deps.openBaseUrl ?? DEFAULT_OPEN_BASE_URL).replace(/\/+$/, "");
    this.fileStoreRoot = deps.fileStoreRoot ?? DEFAULT_FILE_STORE_ROOT;
  }

  async downloadFileByKey(input: {
    fileKey: string;
    fileName?: string | null;
    messageId?: string | null;
  }) {
    const fileKey = String(input.fileKey || "").trim();
    if (!fileKey) {
      throw new AppError("FEISHU_FILE_KEY_MISSING", 400, "Feishu file key is required");
    }

    const config = this.deps.connectorConfigService.getConfig("feishu");
    const appId = String(config.appId || "").trim();
    const appSecret = String(config.appSecret || "").trim();
    if (!appId || !appSecret) {
      throw new AppError("FEISHU_FILE_CREDENTIALS_MISSING", 400, "Feishu app credentials are not configured");
    }

    const token = await this.fetchTenantAccessToken(appId, appSecret);
    const response = await this.downloadWithFallback({
      token,
      fileKey,
      messageId: input.messageId ?? null
    });

    const arrayBuffer = await response.arrayBuffer();
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const extension = this.resolveExtension(contentType, input.fileName || "");
    const savedPath = this.resolveStoragePath({
      fileKey,
      fileName: input.fileName ?? null,
      messageId: input.messageId ?? null,
      extension
    });

    mkdirSync(dirname(savedPath), { recursive: true });
    writeFileSync(savedPath, Buffer.from(arrayBuffer));
    return {
      fileKey,
      savedPath
    };
  }

  private async downloadWithFallback(input: {
    token: string;
    fileKey: string;
    messageId: string | null;
  }) {
    if (input.messageId) {
      const response = await this.fetchImpl(
        `${this.openBaseUrl}/open-apis/im/v1/messages/${encodeURIComponent(input.messageId)}/resources/${encodeURIComponent(input.fileKey)}?type=file`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${input.token}`
          }
        }
      );
      if (response.ok) {
        return response;
      }
    }

    const direct = await this.fetchImpl(`${this.openBaseUrl}/open-apis/im/v1/files/${encodeURIComponent(input.fileKey)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${input.token}`
      }
    });
    if (!direct.ok) {
      const responseText = await direct.text().catch(() => "");
      throw new AppError(
        "FEISHU_FILE_DOWNLOAD_FAILED",
        502,
        `Failed to download Feishu file: status=${direct.status} body=${responseText || "<empty>"}`
      );
    }
    return direct;
  }

  private resolveStoragePath(input: {
    fileKey: string;
    fileName: string | null;
    messageId: string | null;
    extension: string;
  }) {
    const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const messageToken = (input.messageId || "msg").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 48) || "msg";
    const keyToken = input.fileKey.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 64) || "file";
    const nameToken = (input.fileName || "").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 48);
    const baseName = nameToken || `${Date.now()}_${messageToken}_${keyToken}`;
    const finalName = baseName.endsWith(input.extension) ? baseName : `${baseName}${input.extension}`;
    return resolve(this.fileStoreRoot, day, finalName);
  }

  private resolveExtension(contentType: string, fileName: string) {
    const lowerName = String(fileName || "").toLowerCase();
    const byName = lowerName.match(/\.([a-z0-9]{1,10})$/);
    if (byName) {
      return `.${byName[1]}`;
    }
    if (contentType.includes("application/pdf")) {
      return ".pdf";
    }
    if (contentType.includes("text/plain")) {
      return ".txt";
    }
    if (contentType.includes("application/zip")) {
      return ".zip";
    }
    if (contentType.includes("application/json")) {
      return ".json";
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
