import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ConnectorConfigService } from "../modules/connectors/connector-config-service";

const connectorConfigSchema = z.object({
  platform: z.enum(["feishu", "qq"]),
  enabled: z.boolean(),
  appId: z.string(),
  appSecret: z.string(),
  eventMode: z.enum(["webhook", "websocket"]),
  callbackUrl: z.string(),
  defaultChannelName: z.string().nullable(),
  confirmTimeoutSeconds: z.number().int().positive(),
  riskKeywords: z.array(z.string()),
  templateTaskStarted: z.string(),
  templateTaskSucceeded: z.string(),
  templateTaskFailed: z.string(),
  templateTaskPendingConfirm: z.string(),
  sessionPrefix: z.string()
});

export function registerConnectorRoutes(app: FastifyInstance, connectorConfigService: ConnectorConfigService) {
  app.get<{ Params: { platform: "feishu" | "qq" } }>("/api/connectors/:platform/config", async (request) => {
    return connectorConfigService.getConfig(request.params.platform);
  });

  app.put<{ Params: { platform: "feishu" | "qq" }; Body: unknown }>(
    "/api/connectors/:platform/config",
    async (request) => {
      const payload = connectorConfigSchema.parse(request.body);
      return connectorConfigService.updateConfig(request.params.platform, payload);
    }
  );

  app.post<{ Params: { platform: "feishu" | "qq" } }>("/api/connectors/:platform/test", async (request) => {
    return connectorConfigService.testConnection(request.params.platform);
  });
}
