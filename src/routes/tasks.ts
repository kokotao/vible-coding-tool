import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { LightOpsService } from "../modules/ops/light-ops-service";
import { TaskQueryService } from "../modules/tasks/task-query-service";

const operationBodySchema = z
  .object({
    actorId: z.string().min(1).optional(),
    sourcePlatform: z.string().min(1).optional()
  })
  .optional();

export function registerTaskRoutes(
  app: FastifyInstance,
  taskQueryService: TaskQueryService,
  lightOpsService: LightOpsService
) {
  app.get<{ Params: { taskId: string } }>("/api/tasks/:taskId/detail", async (request) => {
    return taskQueryService.getTaskDetail(request.params.taskId);
  });

  app.post<{ Params: { taskId: string }; Body: unknown }>("/api/tasks/:taskId/stop", async (request) => {
    const payload = operationBodySchema.parse(request.body);
    return lightOpsService.stopTask(request.params.taskId, payload);
  });

  app.post<{ Params: { taskId: string }; Body: unknown }>(
    "/api/tasks/:taskId/retry-notify",
    async (request) => {
      const payload = operationBodySchema.parse(request.body);
      return lightOpsService.retryNotify(request.params.taskId, payload);
    }
  );
}
