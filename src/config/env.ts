import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default("127.0.0.1"),
  LOG_LEVEL: z.string().min(1).default("info"),
  LOG_DIR: z.string().min(1).default("./logs"),
  AUTO_OPEN_BROWSER: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value ? value === "true" : process.env.NODE_ENV !== "test")),
  LOG_RETENTION_DAYS: z.coerce.number().int().positive().min(1).max(365).default(7),
  DATABASE_PATH: z.string().min(1).default("./data/gateway.db"),
  WEB_ADMIN_TOKEN: z.string().optional(),
  CODEX_INGRESS_TOKEN: z.string().optional(),
  CODEX_INGRESS_SIGNING_SECRET: z.string().optional(),
  CODEX_INGRESS_MAX_SKEW_SECONDS: z.coerce.number().int().positive().max(3600).default(300),
  FEISHU_VERIFY_TOKEN: z.string().optional(),
  FEISHU_ENCRYPT_KEY: z.string().optional(),
  FEISHU_OPEN_BASE_URL: z.string().min(1).default("https://open.feishu.cn"),
  FEISHU_WS_AUTO_START: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value ? value === "true" : process.env.NODE_ENV !== "test")),
  QQ_WS_AUTO_START: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value ? value === "true" : process.env.NODE_ENV !== "test")),
  CODEX_LOCAL_SESSIONS_SCAN_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value ? value === "true" : process.env.NODE_ENV !== "test")),
  CODEX_LOCAL_SESSIONS_ROOT: z.string().min(1).default("~/.codex/sessions"),
  CODEX_LOCAL_SESSIONS_SCAN_INTERVAL_MS: z.coerce.number().int().positive().min(1000).max(86_400_000).default(15_000),
  CODEX_AUTO_DISPATCH_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value ? value === "true" : process.env.NODE_ENV !== "test")),
  CODEX_CLI_BIN: z.string().min(1).default("codex"),
  CODEX_CLI_SKIP_GIT_REPO_CHECK: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value ? value === "true" : true))
});

export type AppEnv = {
  port: number;
  host: string;
  logLevel: string;
  logDir: string;
  autoOpenBrowser: boolean;
  logRetentionDays: number;
  databasePath: string;
  webAdminToken: string | undefined;
  codexIngressToken: string | undefined;
  codexIngressSigningSecret: string | undefined;
  codexIngressMaxSkewSeconds: number;
  feishuVerifyToken: string | undefined;
  feishuEncryptKey: string | undefined;
  feishuOpenBaseUrl: string;
  feishuWsAutoStart: boolean;
  qqWsAutoStart: boolean;
  codexLocalSessionsScanEnabled: boolean;
  codexLocalSessionsRoot: string;
  codexLocalSessionsScanIntervalMs: number;
  codexAutoDispatchEnabled: boolean;
  codexCliBin: string;
  codexCliSkipGitRepoCheck: boolean;
};

export function loadEnv(input: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = envSchema.parse(input);

  return {
    port: parsed.PORT,
    host: parsed.HOST,
    logLevel: parsed.LOG_LEVEL,
    logDir: parsed.LOG_DIR,
    autoOpenBrowser: parsed.AUTO_OPEN_BROWSER,
    logRetentionDays: parsed.LOG_RETENTION_DAYS,
    databasePath: parsed.DATABASE_PATH,
    webAdminToken: parsed.WEB_ADMIN_TOKEN,
    codexIngressToken: parsed.CODEX_INGRESS_TOKEN,
    codexIngressSigningSecret: parsed.CODEX_INGRESS_SIGNING_SECRET,
    codexIngressMaxSkewSeconds: parsed.CODEX_INGRESS_MAX_SKEW_SECONDS,
    feishuVerifyToken: parsed.FEISHU_VERIFY_TOKEN,
    feishuEncryptKey: parsed.FEISHU_ENCRYPT_KEY,
    feishuOpenBaseUrl: parsed.FEISHU_OPEN_BASE_URL,
    feishuWsAutoStart: parsed.FEISHU_WS_AUTO_START,
    qqWsAutoStart: parsed.QQ_WS_AUTO_START,
    codexLocalSessionsScanEnabled: parsed.CODEX_LOCAL_SESSIONS_SCAN_ENABLED,
    codexLocalSessionsRoot: parsed.CODEX_LOCAL_SESSIONS_ROOT,
    codexLocalSessionsScanIntervalMs: parsed.CODEX_LOCAL_SESSIONS_SCAN_INTERVAL_MS,
    codexAutoDispatchEnabled: parsed.CODEX_AUTO_DISPATCH_ENABLED,
    codexCliBin: parsed.CODEX_CLI_BIN,
    codexCliSkipGitRepoCheck: parsed.CODEX_CLI_SKIP_GIT_REPO_CHECK
  };
}

export function mergeEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    ...loadEnv(),
    ...overrides
  };
}
