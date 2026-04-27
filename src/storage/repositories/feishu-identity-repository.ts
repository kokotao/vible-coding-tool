/**
 * @description 飞书身份映射仓储，维护 open_id 与姓名的持久化关系
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-27 20:10
 */
import type { SqliteDatabase } from "../sqlite";

export type FeishuIdentityBindingSource = "auto" | "manual";

export type FeishuIdentityRecord = {
  openId: string;
  displayName: string;
  bindingSource: FeishuIdentityBindingSource;
  boundBy: string | null;
  createdAt: string;
  updatedAt: string;
};

type FeishuIdentityRow = {
  openId: string;
  displayName: string;
  bindingSource: FeishuIdentityBindingSource;
  boundBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export class FeishuIdentityRepository {
  constructor(private readonly db: SqliteDatabase) {}

  findByOpenId(openId: string) {
    const statement = this.db.prepare(`
      SELECT
        open_id AS openId,
        display_name AS displayName,
        binding_source AS bindingSource,
        bound_by AS boundBy,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM feishu_identity_bindings
      WHERE open_id = ?
      LIMIT 1
    `);

    const row = statement.get(openId.trim()) as FeishuIdentityRow | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  listRecent(limit: number) {
    const statement = this.db.prepare(`
      SELECT
        open_id AS openId,
        display_name AS displayName,
        binding_source AS bindingSource,
        bound_by AS boundBy,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM feishu_identity_bindings
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `);

    return (statement.all(limit) as FeishuIdentityRow[]).map((row) => this.mapRow(row));
  }

  upsertAuto(input: { openId: string; displayName: string; updatedAt: string }) {
    const existing = this.findByOpenId(input.openId);
    if (existing?.bindingSource === "manual") {
      return existing;
    }

    if (existing) {
      const statement = this.db.prepare(`
        UPDATE feishu_identity_bindings
        SET display_name = @displayName,
            binding_source = 'auto',
            bound_by = NULL,
            updated_at = @updatedAt
        WHERE open_id = @openId
      `);

      statement.run({
        openId: input.openId.trim(),
        displayName: input.displayName.trim(),
        updatedAt: input.updatedAt
      });

      return this.findByOpenId(input.openId);
    }

    const statement = this.db.prepare(`
      INSERT INTO feishu_identity_bindings (
        open_id, display_name, binding_source, bound_by, created_at, updated_at
      ) VALUES (
        @openId, @displayName, 'auto', NULL, @createdAt, @updatedAt
      )
    `);

    statement.run({
      openId: input.openId.trim(),
      displayName: input.displayName.trim(),
      createdAt: input.updatedAt,
      updatedAt: input.updatedAt
    });

    return this.findByOpenId(input.openId);
  }

  upsertManual(input: { openId: string; displayName: string; boundBy?: string | null; updatedAt: string }) {
    const existing = this.findByOpenId(input.openId);

    if (existing) {
      const statement = this.db.prepare(`
        UPDATE feishu_identity_bindings
        SET display_name = @displayName,
            binding_source = 'manual',
            bound_by = @boundBy,
            updated_at = @updatedAt
        WHERE open_id = @openId
      `);

      statement.run({
        openId: input.openId.trim(),
        displayName: input.displayName.trim(),
        boundBy: input.boundBy?.trim() || null,
        updatedAt: input.updatedAt
      });

      return this.findByOpenId(input.openId);
    }

    const statement = this.db.prepare(`
      INSERT INTO feishu_identity_bindings (
        open_id, display_name, binding_source, bound_by, created_at, updated_at
      ) VALUES (
        @openId, @displayName, 'manual', @boundBy, @createdAt, @updatedAt
      )
    `);

    statement.run({
      openId: input.openId.trim(),
      displayName: input.displayName.trim(),
      boundBy: input.boundBy?.trim() || null,
      createdAt: input.updatedAt,
      updatedAt: input.updatedAt
    });

    return this.findByOpenId(input.openId);
  }

  private mapRow(row: FeishuIdentityRow): FeishuIdentityRecord {
    return {
      openId: row.openId,
      displayName: row.displayName,
      bindingSource: row.bindingSource,
      boundBy: row.boundBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }
}
