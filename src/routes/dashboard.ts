import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { AppError } from "../lib/errors";
import { DashboardService } from "../modules/dashboard/dashboard-service";

export function registerDashboardRoutes(app: FastifyInstance, dashboardService: DashboardService) {
  app.get("/api/dashboard/summary", async () => {
    return dashboardService.getSummary();
  });

  app.get("/api/dashboard/readme", async () => {
    const readmePath = resolveReadmePath();
    if (!readmePath) {
      throw new AppError("README_NOT_FOUND", 404, "README.md not found");
    }

    const [content, stats] = await Promise.all([readFile(readmePath, "utf8"), stat(readmePath)]);
    return {
      fileName: "README.md",
      path: readmePath,
      updatedAt: stats.mtime.toISOString(),
      content
    };
  });
}

function resolveReadmePath(): string | null {
  const candidates = [
    resolve(process.cwd(), "README.md"),
    resolve(__dirname, "..", "..", "README.md"),
    resolve(__dirname, "..", "..", "..", "README.md")
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}
