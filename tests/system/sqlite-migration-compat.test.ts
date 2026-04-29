import { describe, expect, it } from "vitest";
import { createSqliteDatabase, migrateDatabase } from "../../src/storage/sqlite";
import { FeishuSessionRouteRepository } from "../../src/storage/repositories/feishu-session-route-repository";

describe("sqlite migration compatibility", () => {
  it("auto-creates feishu_session_routes for legacy databases", () => {
    const db = createSqliteDatabase(":memory:");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          action TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          result TEXT NOT NULL,
          detail TEXT,
          created_at TEXT NOT NULL
        );
      `);

      migrateDatabase(db);

      const routeRepository = new FeishuSessionRouteRepository(db);
      const now = "2026-04-28T15:45:39.656Z";
      const inserted = routeRepository.upsert({
        sessionId: "feishu-session-legacy-compat",
        sourcePlatform: "feishu",
        chatType: "group",
        chatId: "oc_xxx",
        senderOpenId: "ou_legacy_user",
        lastPlatformMessageId: "msg-legacy-1",
        routeStatus: "active",
        createdAt: now,
        updatedAt: now
      });

      expect(inserted).toEqual(
        expect.objectContaining({
          sessionId: "feishu-session-legacy-compat",
          senderOpenId: "ou_legacy_user",
          routeStatus: "active"
        })
      );
    } finally {
      db.close();
    }
  });
});
