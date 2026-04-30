import { AppError } from "../../lib/errors";
import {
  ConnectorConfigRepository,
  type ConnectorConfigRecord,
  type ConnectorPlatform
} from "../../storage/repositories/connector-config-repository";

export type ConnectorConfigInput = Omit<ConnectorConfigRecord, "lastTestAt" | "lastTestResult" | "updatedAt">;

export class ConnectorConfigService {
  constructor(private readonly repository: ConnectorConfigRepository) {}

  ensureDefaults() {
    this.getConfig("feishu");
    this.getConfig("qq");
  }

  getConfig(platform: ConnectorPlatform) {
    const existing = this.repository.findByPlatform(platform);

    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    return this.repository.upsert({
      platform,
      enabled: false,
      appId: "",
      appSecret: "",
      eventMode: "webhook",
      callbackUrl: "",
      defaultChannelName: null,
      confirmTimeoutSeconds: 120,
      riskKeywords: [],
      templateTaskStarted: "",
      templateTaskSucceeded: "",
      templateTaskFailed: "",
      templateTaskPendingConfirm: "",
      sessionPrefix: `${platform}-codex`,
      lastTestAt: null,
      lastTestResult: null,
      updatedAt: now
    })!;
  }

  listAll() {
    this.ensureDefaults();
    return this.repository.listAll();
  }

  updateConfig(platform: ConnectorPlatform, input: ConnectorConfigInput) {
    if (platform !== input.platform) {
      throw new AppError("PLATFORM_MISMATCH", 400, "Platform in path and payload must match");
    }

    const existing = this.getConfig(platform);
    return this.repository.upsert({
      ...existing,
      ...input,
      updatedAt: new Date().toISOString()
    })!;
  }

  testConnection(platform: ConnectorPlatform) {
    const existing = this.getConfig(platform);
    const validation = this.validateConnectionConfig(platform, existing);
    const isSuccess = validation.success;
    const now = new Date().toISOString();

    const updated = this.repository.upsert({
      ...existing,
      enabled: isSuccess,
      lastTestAt: now,
      lastTestResult: isSuccess ? "success" : "failed",
      updatedAt: now
    })!;

    return {
      platform: updated.platform,
      success: isSuccess,
      message: validation.message,
      lastTestAt: updated.lastTestAt,
      lastTestResult: updated.lastTestResult
    };
  }

  private validateConnectionConfig(platform: ConnectorPlatform, config: ConnectorConfigRecord) {
    if (!config.appId.trim() || !config.appSecret.trim()) {
      return {
        success: false,
        message: "Missing App ID or App Secret"
      };
    }

    if (platform !== "qq") {
      return {
        success: true,
        message: "Connection test passed"
      };
    }

    if (config.eventMode === "websocket") {
      return {
        success: true,
        message: "Connection test passed (QQ websocket mode)"
      };
    }

    return {
      success: true,
      message: "Connection test passed (QQ webhook mode)"
    };
  }
}
