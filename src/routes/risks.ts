/**
 * @description 风险轻操作路由，提供网页端确认与拒绝接口
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-26 18:20
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { LightOpsService } from "../modules/ops/light-ops-service";

const operationBodySchema = z
  .object({
    actorId: z.string().min(1).optional(),
    sourcePlatform: z.string().min(1).optional()
  })
  .optional();

export function registerRiskRoutes(app: FastifyInstance, lightOpsService: LightOpsService) {
  app.post<{ Params: { token: string }; Body: unknown }>("/api/risks/:token/confirm", async (request) => {
    const payload = operationBodySchema.parse(request.body);
    return lightOpsService.confirmRisk(request.params.token, payload);
  });

  app.post<{ Params: { token: string }; Body: unknown }>("/api/risks/:token/reject", async (request) => {
    const payload = operationBodySchema.parse(request.body);
    return lightOpsService.rejectRisk(request.params.token, payload);
  });
}
