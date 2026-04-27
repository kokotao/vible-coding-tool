import type { FastifyInstance } from "fastify";
import { DashboardService } from "../modules/dashboard/dashboard-service";

export function registerDashboardRoutes(app: FastifyInstance, dashboardService: DashboardService) {
  app.get("/api/dashboard/summary", async () => {
    return dashboardService.getSummary();
  });
}
