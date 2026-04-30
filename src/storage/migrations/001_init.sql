CREATE TABLE IF NOT EXISTS tool_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL UNIQUE,
  tool_provider TEXT NOT NULL,
  tool_session_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  thread_ref TEXT NOT NULL,
  thread_alias TEXT NOT NULL,
  thread_name TEXT,
  last_task_id TEXT,
  last_summary TEXT,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(session_id, thread_ref),
  UNIQUE(session_id, thread_alias)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  platform_message_id TEXT,
  sender_id TEXT NOT NULL,
  content TEXT NOT NULL,
  message_type TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  status TEXT NOT NULL,
  task_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feishu_identity_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  open_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  binding_source TEXT NOT NULL,
  bound_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feishu_panel_contexts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  open_id TEXT NOT NULL UNIQUE,
  current_view TEXT NOT NULL,
  selected_project_name TEXT,
  selected_project_path TEXT,
  selected_thread_id TEXT,
  selected_session_title TEXT,
  selected_model_slug TEXT,
  selected_model_name TEXT,
  selected_reasoning_level TEXT,
  pending_compose_mode TEXT,
  last_action TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feishu_session_routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL UNIQUE,
  source_platform TEXT NOT NULL,
  chat_type TEXT NOT NULL,
  chat_id TEXT,
  sender_open_id TEXT NOT NULL,
  last_platform_message_id TEXT,
  route_status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  trigger_message_id TEXT,
  task_type TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS risk_confirmations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  confirmation_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  expired_at TEXT NOT NULL,
  confirmed_by TEXT,
  confirmed_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  task_id TEXT,
  session_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  result TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connector_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 0,
  app_id TEXT NOT NULL DEFAULT '',
  app_secret TEXT NOT NULL DEFAULT '',
  event_mode TEXT NOT NULL DEFAULT 'webhook',
  callback_url TEXT NOT NULL DEFAULT '',
  default_channel_name TEXT,
  confirm_timeout_seconds INTEGER NOT NULL DEFAULT 120,
  risk_keywords_json TEXT NOT NULL DEFAULT '[]',
  template_task_started TEXT NOT NULL DEFAULT '',
  template_task_succeeded TEXT NOT NULL DEFAULT '',
  template_task_failed TEXT NOT NULL DEFAULT '',
  template_task_pending_confirm TEXT NOT NULL DEFAULT '',
  session_prefix TEXT NOT NULL DEFAULT '',
  last_test_at TEXT,
  last_test_result TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_started_id
  ON tasks(status, started_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_tasks_session_started_id
  ON tasks(session_id, started_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_tasks_finished_started_id
  ON tasks(finished_at, started_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_tool_sessions_provider_status_updated_id
  ON tool_sessions(tool_provider, status, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_messages_task_created_id
  ON messages(task_id, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_messages_session_created_id
  ON messages(session_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_messages_sender_platform_direction_created_id
  ON messages(sender_id, source_platform, direction, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_risk_confirmations_status_expired_id
  ON risk_confirmations(status, expired_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_risk_confirmations_task_expired_id
  ON risk_confirmations(task_id, expired_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_session_created_id
  ON audit_logs(session_id, created_at DESC, id DESC);
