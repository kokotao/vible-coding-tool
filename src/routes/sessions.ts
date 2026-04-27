import type { FastifyInstance } from "fastify";
import { SessionQueryService } from "../modules/sessions/session-query-service";

export function registerSessionRoutes(app: FastifyInstance, sessionQueryService: SessionQueryService) {
  app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/detail", async (request) => {
    return sessionQueryService.getSessionDetail(request.params.sessionId);
  });
}
