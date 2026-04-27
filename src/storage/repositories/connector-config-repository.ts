import type { SqliteDatabase } from "../sqlite";

export type ConnectorPlatform = "feishu" | "qq";

export type ConnectorConfigRecord = {
  platform: ConnectorPlatform;
  enabled: boolean;
  appId: string;
  appSecret: string;
  eventMode: "websocket" | "webhook";
  callbackUrl: string;
  defaultChannelName: string | null;
  confirmTimeoutSeconds: number;
  riskKeywords: string[];
  templateTaskStarted: string;
  templateTaskSucceeded: string;
  templateTaskFailed: string;
  templateTaskPendingConfirm: string;
  sessionPrefix: string;
  lastTestAt: string | null;
  lastTestResult: "success" | "failed" | null;
  updatedAt: string;
};

type ConnectorConfigRow = {
  platform: ConnectorPlatform;
  enabled: number;
  appId: string;
  appSecret: string;
  eventMode: "websocket" | "webhook";
  callbackUrl: string;
  defaultChannelName: string | null;
  confirmTimeoutSeconds: number;
  riskKeywordsJson: string;
  templateTaskStarted: string;
  templateTaskSucceeded: string;
  templateTaskFailed: string;
  templateTaskPendingConfirm: string;
  sessionPrefix: string;
  lastTestAt: string | null;
  lastTestResult: "success" | "failed" | null;
  updatedAt: string;
};

export class ConnectorConfigRepository {
  constructor(private readonly db: SqliteDatabase) {}

  upsert(record: ConnectorConfigRecord) {
    const statement = this.db.prepare(`
      INSERT INTO connector_configs (
        platform, enabled, app_id, app_secret, event_mode, callback_url, default_channel_name,
        confirm_timeout_seconds, risk_keywords_json, template_task_started, template_task_succeeded,
        template_task_failed, template_task_pending_confirm, session_prefix, last_test_at,
        last_test_result, updated_at
      ) VALUES (
        @platform, @enabled, @appId, @appSecret, @eventMode, @callbackUrl, @defaultChannelName,
        @confirmTimeoutSeconds, @riskKeywordsJson, @templateTaskStarted, @templateTaskSucceeded,
        @templateTaskFailed, @templateTaskPendingConfirm, @sessionPrefix, @lastTestAt,
        @lastTestResult, @updatedAt
      )
      ON CONFLICT(platform) DO UPDATE SET
        enabled = excluded.enabled,
        app_id = excluded.app_id,
        app_secret = excluded.app_secret,
        event_mode = excluded.event_mode,
        callback_url = excluded.callback_url,
        default_channel_name = excluded.default_channel_name,
        confirm_timeout_seconds = excluded.confirm_timeout_seconds,
        risk_keywords_json = excluded.risk_keywords_json,
        template_task_started = excluded.template_task_started,
        template_task_succeeded = excluded.template_task_succeeded,
        template_task_failed = excluded.template_task_failed,
        template_task_pending_confirm = excluded.template_task_pending_confirm,
        session_prefix = excluded.session_prefix,
        last_test_at = excluded.last_test_at,
        last_test_result = excluded.last_test_result,
        updated_at = excluded.updated_at
    `);

    statement.run({
      ...record,
      enabled: record.enabled ? 1 : 0,
      riskKeywordsJson: JSON.stringify(record.riskKeywords)
    });

    return this.findByPlatform(record.platform);
  }

  findByPlatform(platform: ConnectorPlatform) {
    const statement = this.db.prepare(`
      SELECT
        platform,
        enabled,
        app_id AS appId,
        app_secret AS appSecret,
        event_mode AS eventMode,
        callback_url AS callbackUrl,
        default_channel_name AS defaultChannelName,
        confirm_timeout_seconds AS confirmTimeoutSeconds,
        risk_keywords_json AS riskKeywordsJson,
        template_task_started AS templateTaskStarted,
        template_task_succeeded AS templateTaskSucceeded,
        template_task_failed AS templateTaskFailed,
        template_task_pending_confirm AS templateTaskPendingConfirm,
        session_prefix AS sessionPrefix,
        last_test_at AS lastTestAt,
        last_test_result AS lastTestResult,
        updated_at AS updatedAt
      FROM connector_configs
      WHERE platform = ?
    `);

    const row = statement.get(platform) as ConnectorConfigRow | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  listAll() {
    const statement = this.db.prepare(`
      SELECT
        platform,
        enabled,
        app_id AS appId,
        app_secret AS appSecret,
        event_mode AS eventMode,
        callback_url AS callbackUrl,
        default_channel_name AS defaultChannelName,
        confirm_timeout_seconds AS confirmTimeoutSeconds,
        risk_keywords_json AS riskKeywordsJson,
        template_task_started AS templateTaskStarted,
        template_task_succeeded AS templateTaskSucceeded,
        template_task_failed AS templateTaskFailed,
        template_task_pending_confirm AS templateTaskPendingConfirm,
        session_prefix AS sessionPrefix,
        last_test_at AS lastTestAt,
        last_test_result AS lastTestResult,
        updated_at AS updatedAt
      FROM connector_configs
      ORDER BY platform ASC
    `);

    return (statement.all() as ConnectorConfigRow[]).map((row) => this.mapRow(row));
  }

  private mapRow(row: ConnectorConfigRow): ConnectorConfigRecord {
    return {
      platform: row.platform,
      enabled: Boolean(row.enabled),
      appId: row.appId,
      appSecret: row.appSecret,
      eventMode: row.eventMode,
      callbackUrl: row.callbackUrl,
      defaultChannelName: row.defaultChannelName,
      confirmTimeoutSeconds: row.confirmTimeoutSeconds,
      riskKeywords: JSON.parse(row.riskKeywordsJson) as string[],
      templateTaskStarted: row.templateTaskStarted,
      templateTaskSucceeded: row.templateTaskSucceeded,
      templateTaskFailed: row.templateTaskFailed,
      templateTaskPendingConfirm: row.templateTaskPendingConfirm,
      sessionPrefix: row.sessionPrefix,
      lastTestAt: row.lastTestAt,
      lastTestResult: row.lastTestResult,
      updatedAt: row.updatedAt
    };
  }
}
