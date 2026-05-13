import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ConnectorConfigService } from "../modules/connectors/connector-config-service";
import { type AdminAccessOptions, verifyAdminAccess } from "../modules/security/admin-auth";

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

export function registerConnectorRoutes(
  app: FastifyInstance,
  connectorConfigService: ConnectorConfigService,
  adminAccessOptions: AdminAccessOptions
) {
  app.get<{ Params: { platform: "feishu" | "qq" } }>("/api/connectors/:platform/config", async (request) => {
    return connectorConfigService.getAdminConfig(request.params.platform);
  });

  app.put<{ Params: { platform: "feishu" | "qq" }; Body: unknown }>(
    "/api/connectors/:platform/config",
    async (request) => {
      verifyAdminAccess(request, adminAccessOptions);
      const payload = connectorConfigSchema.parse(request.body);
      const updated = connectorConfigService.updateConfig(request.params.platform, payload);
      return connectorConfigService.getAdminConfig(updated.platform);
    }
  );

  app.post<{ Params: { platform: "feishu" | "qq" } }>("/api/connectors/:platform/test", async (request) => {
    verifyAdminAccess(request, adminAccessOptions);
    return connectorConfigService.testConnection(request.params.platform);
  });
}
