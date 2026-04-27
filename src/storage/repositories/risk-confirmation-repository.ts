import type { SqliteDatabase } from "../sqlite";

export type RiskConfirmationRecord = {
  taskId: string;
  sessionId: string;
  requestedBy: string;
  confirmationToken: string;
  status: string;
  expiredAt: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
};

export class RiskConfirmationRepository {
  constructor(private readonly db: SqliteDatabase) {}

  create(record: RiskConfirmationRecord) {
    const statement = this.db.prepare(`
      INSERT INTO risk_confirmations (
        task_id, session_id, requested_by, confirmation_token, status,
        expired_at, confirmed_by, confirmed_at
      ) VALUES (
        @taskId, @sessionId, @requestedBy, @confirmationToken, @status,
        @expiredAt, @confirmedBy, @confirmedAt
      )
    `);

    statement.run(record);
    return this.findByToken(record.confirmationToken);
  }

  findByToken(token: string) {
    const statement = this.db.prepare(`
      SELECT
        task_id AS taskId,
        session_id AS sessionId,
        requested_by AS requestedBy,
        confirmation_token AS confirmationToken,
        status,
        expired_at AS expiredAt,
        confirmed_by AS confirmedBy,
        confirmed_at AS confirmedAt
      FROM risk_confirmations
      WHERE confirmation_token = ?
    `);

    return statement.get(token) as RiskConfirmationRecord | undefined;
  }

  listPending(limit: number) {
    const statement = this.db.prepare(`
      SELECT
        task_id AS taskId,
        session_id AS sessionId,
        requested_by AS requestedBy,
        confirmation_token AS confirmationToken,
        status,
        expired_at AS expiredAt,
        confirmed_by AS confirmedBy,
        confirmed_at AS confirmedAt
      FROM risk_confirmations
      WHERE status = 'pending'
      ORDER BY expired_at ASC, id ASC
      LIMIT ?
    `);

    return statement.all(limit) as RiskConfirmationRecord[];
  }

  countPending() {
    const statement = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM risk_confirmations
      WHERE status = 'pending'
    `);

    const result = statement.get() as { count: number };
    return result.count;
  }

  listByTaskId(taskId: string) {
    const statement = this.db.prepare(`
      SELECT
        task_id AS taskId,
        session_id AS sessionId,
        requested_by AS requestedBy,
        confirmation_token AS confirmationToken,
        status,
        expired_at AS expiredAt,
        confirmed_by AS confirmedBy,
        confirmed_at AS confirmedAt
      FROM risk_confirmations
      WHERE task_id = ?
      ORDER BY expired_at DESC, id DESC
    `);

    return statement.all(taskId) as RiskConfirmationRecord[];
  }

  updateDecisionByToken(
    token: string,
    status: string,
    confirmedBy: string,
    confirmedAt: string
  ) {
    const statement = this.db.prepare(`
      UPDATE risk_confirmations
      SET status = @status,
          confirmed_by = @confirmedBy,
          confirmed_at = @confirmedAt
      WHERE confirmation_token = @token
    `);

    statement.run({
      token,
      status,
      confirmedBy,
      confirmedAt
    });

    return this.findByToken(token);
  }
}
