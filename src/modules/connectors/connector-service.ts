import { ConnectorConfigService } from "./connector-config-service";

export type ConnectorSummary = {
  platform: "feishu" | "qq";
  enabled: boolean;
  connectionStatus: "connected" | "disconnected" | "error";
  eventMode: "websocket" | "webhook";
  defaultChannelName: string | null;
  lastTestAt: string | null;
  lastTestResult: "success" | "failed" | null;
};

export class ConnectorService {
  constructor(private readonly configService: ConnectorConfigService) {}

  listSummaries(): ConnectorSummary[] {
    return this.configService.listAll().map((config) => ({
      platform: config.platform,
      enabled: config.enabled,
      connectionStatus: config.lastTestResult === "failed" ? "error" : config.enabled ? "connected" : "disconnected",
      eventMode: config.eventMode,
      defaultChannelName: config.defaultChannelName,
      lastTestAt: config.lastTestAt,
      lastTestResult: config.lastTestResult
    }));
  }
}
