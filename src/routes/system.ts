/**
 * @description 系统配置路由，提供 Codex CLI 运行状态、安装与 API 配置能力
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-28 00:00
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CodexCliRuntimeService } from "../modules/codex/codex-cli-runtime-service";

const codexRuntimeConfigSchema = z.object({
  apiBaseUrl: z.string().trim().max(1024).nullable().optional(),
  apiKey: z.string().trim().max(4096).nullable().optional()
});

const codexInstallSchema = z.object({
  confirm: z.boolean().optional()
});

export function registerSystemRoutes(app: FastifyInstance, codexCliRuntimeService: CodexCliRuntimeService) {
  app.get("/api/system/codex-cli/status", async () => {
    return codexCliRuntimeService.getStatus({
      refresh: true
    });
  });

  app.put<{ Body: unknown }>("/api/system/codex-cli/config", async (request) => {
    const payload = codexRuntimeConfigSchema.parse(request.body);
    return codexCliRuntimeService.saveApiConfig({
      apiBaseUrl: payload.apiBaseUrl ?? undefined,
      apiKey: payload.apiKey ?? undefined
    });
  });

  app.post<{ Body: unknown }>("/api/system/codex-cli/install", async (request, reply) => {
    const payload = codexInstallSchema.parse(request.body || {});
    if (!payload.confirm) {
      reply.status(400);
      return {
        code: "CONFIRM_REQUIRED",
        message: "Install Codex CLI requires confirm=true"
      };
    }

    const install = await codexCliRuntimeService.installCli({
      inheritStdio: false
    });
    const status = codexCliRuntimeService.getStatus({
      refresh: true
    });
    if (!install.success) {
      reply.status(500);
    }

    return {
      ...install,
      status
    };
  });

  app.post("/api/system/codex-cli/authorize-project", async () => {
    const updated = codexCliRuntimeService.authorizeProjectTrust();
    return {
      updated,
      status: codexCliRuntimeService.getStatus({
        refresh: true
      })
    };
  });
}
