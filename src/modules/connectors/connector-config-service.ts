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
    const isSuccess = existing.appId.trim().length > 0 && existing.appSecret.trim().length > 0;
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
      message: isSuccess ? "Connection test passed" : "Missing App ID or App Secret",
      lastTestAt: updated.lastTestAt,
      lastTestResult: updated.lastTestResult
    };
  }
}
