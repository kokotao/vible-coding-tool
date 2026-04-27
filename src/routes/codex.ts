/**
 * @description Codex 事件入站路由，负责接收任务状态事件并同步到网关状态机
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-26 18:20
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { type CodexIngressSecurityOptions, verifyCodexIngress } from "../modules/codex/codex-ingress-security";
import { CodexEventService } from "../modules/codex/codex-event-service";
import { CodexQueryService } from "../modules/codex/codex-query-service";
import { IdempotencyRepository } from "../storage/repositories/idempotency-repository";

const codexEventSchema = z.object({
  eventId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  sessionId: z.string().min(1),
  toolSessionRef: z.string().min(1).optional(),
  status: z.enum(["running", "succeeded", "failed"]),
  summary: z.string().optional(),
  detail: z.string().optional(),
  senderId: z.string().optional(),
  occurredAt: z.string().optional()
});

const codexBatchEventSchema = z.object({
  events: z.array(codexEventSchema).min(1).max(200)
});

const codexListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  statuses: z.string().optional()
});

const codexOverviewQuerySchema = z.object({
  taskLimit: z.coerce.number().int().positive().max(100).optional(),
  sessionLimit: z.coerce.number().int().positive().max(100).optional(),
  sinceHours: z.coerce.number().int().positive().max(720).optional()
});

const codexTaskEventsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional()
});

function parseStatuses(value: string | undefined) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function registerCodexRoutes(
  app: FastifyInstance,
  codexEventService: CodexEventService,
  codexQueryService: CodexQueryService,
  idempotencyRepository: IdempotencyRepository,
  ingressSecurityOptions: CodexIngressSecurityOptions
) {
  app.post<{ Body: unknown }>("/api/codex/events", async (request) => {
    verifyCodexIngress({
      headers: request.headers,
      payload: request.body,
      options: ingressSecurityOptions,
      idempotencyRepository
    });
    const payload = codexEventSchema.parse(request.body);
    return codexEventService.handleEvent(payload);
  });

  app.post<{ Body: unknown }>("/api/codex/events/batch", async (request, reply) => {
    verifyCodexIngress({
      headers: request.headers,
      payload: request.body,
      options: ingressSecurityOptions,
      idempotencyRepository
    });
    const payload = codexBatchEventSchema.parse(request.body);

    const items: Array<{
      index: number;
      accepted: boolean;
      duplicate: boolean;
      eventId: string | null;
      taskId: string | null;
      sessionId: string | null;
      status: string | null;
      code?: string;
      message?: string;
    }> = [];

    let processedCount = 0;
    let duplicateCount = 0;
    let failedCount = 0;

    for (const [index, event] of payload.events.entries()) {
      try {
        const result = await codexEventService.handleEvent(event);
        processedCount += 1;
        if (result.duplicate) {
          duplicateCount += 1;
        }

        items.push({
          index,
          accepted: true,
          duplicate: result.duplicate,
          eventId: result.eventId ?? null,
          taskId: result.taskId ?? null,
          sessionId: result.sessionId ?? null,
          status: result.status ?? null
        });
      } catch (error) {
        failedCount += 1;
        if (error instanceof AppError) {
          items.push({
            index,
            accepted: false,
            duplicate: false,
            eventId: event.eventId ?? null,
            taskId: event.taskId ?? null,
            sessionId: event.sessionId ?? null,
            status: null,
            code: error.code,
            message: error.message
          });
          continue;
        }

        throw error;
      }
    }

    if (failedCount > 0) {
      reply.status(207);
    }

    return {
      accepted: failedCount === 0,
      total: payload.events.length,
      processedCount,
      duplicateCount,
      failedCount,
      items
    };
  });

  app.get<{ Querystring: { limit?: string; statuses?: string } }>("/api/codex/sessions", async (request) => {
    const query = codexListQuerySchema.parse(request.query);
    return codexQueryService.listSessions({
      limit: query.limit ?? 20,
      statuses: parseStatuses(query.statuses)
    });
  });

  app.get<{ Querystring: { limit?: string; statuses?: string } }>("/api/codex/tasks", async (request) => {
    const query = codexListQuerySchema.parse(request.query);
    return codexQueryService.listTasks({
      limit: query.limit ?? 20,
      statuses: parseStatuses(query.statuses)
    });
  });

  app.get<{ Querystring: { limit?: string } }>("/api/codex/tasks/active", async (request) => {
    const query = codexListQuerySchema.parse(request.query);
    return codexQueryService.listTasks({
      limit: query.limit ?? 20,
      statuses: ["running"]
    });
  });

  app.get<{ Querystring: { taskLimit?: string; sessionLimit?: string; sinceHours?: string } }>(
    "/api/codex/overview",
    async (request) => {
      const query = codexOverviewQuerySchema.parse(request.query);
      return codexQueryService.getOverview({
        taskLimit: query.taskLimit ?? 8,
        sessionLimit: query.sessionLimit ?? 8,
        sinceHours: query.sinceHours
      });
    }
  );

  app.get<{ Params: { taskId: string }; Querystring: { limit?: string } }>(
    "/api/codex/tasks/:taskId/events",
    async (request) => {
      const query = codexTaskEventsQuerySchema.parse(request.query);
      return codexQueryService.getTaskEvents({
        taskId: request.params.taskId,
        limit: query.limit ?? 100
      });
    }
  );
}
