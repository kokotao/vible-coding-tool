import type { SqliteDatabase } from "../sqlite";

export type IdempotencyRecord = {
  idempotencyKey: string;
  scope: string;
  createdAt: string;
};

export class IdempotencyRepository {
  constructor(private readonly db: SqliteDatabase) {}

  saveIfAbsent(record: IdempotencyRecord) {
    const statement = this.db.prepare(`
      INSERT OR IGNORE INTO idempotency_keys (idempotency_key, scope, created_at)
      VALUES (@idempotencyKey, @scope, @createdAt)
    `);

    const result = statement.run(record);
    return result.changes === 1;
  }

  findByKey(idempotencyKey: string) {
    const statement = this.db.prepare(`
      SELECT
        idempotency_key AS idempotencyKey,
        scope,
        created_at AS createdAt
      FROM idempotency_keys
      WHERE idempotency_key = ?
    `);

    return statement.get(idempotencyKey) as IdempotencyRecord | undefined;
  }
}
