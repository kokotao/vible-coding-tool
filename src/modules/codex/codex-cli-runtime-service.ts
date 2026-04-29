/**
 * @description Codex CLI 运行时初始化服务，负责启动扫描、安装检测、项目授权与 API 配置持久化
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-27 23:58
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { CodexLocalSessionService } from "./codex-local-session-service";

type LoggerLike = {
  info?: (payload: unknown, message?: string) => void;
  warn?: (payload: unknown, message?: string) => void;
  error?: (payload: unknown, message?: string) => void;
};

type PersistedCodexRuntimeConfig = {
  apiBaseUrl: string;
  apiKey: string;
  updatedAt: string;
  apiProbePassed: boolean;
  apiProbeCheckedAt: string;
  apiProbeMessage: string;
  apiProbeTarget: string;
};

type SessionScanState = {
  enabled: boolean;
  scannedAt: string | null;
  totalThreads: number;
  totalFiles: number;
  error: string | null;
};

type InstallResult = {
  success: boolean;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

type RuntimeSnapshot = {
  installed: boolean;
  version: string | null;
  resolvedCodexBin: string | null;
  detectionMessage: string | null;
  trustedInConfig: boolean;
  trustLevel: string | null;
  statusCheckedAt: string;
};

export type CodexCliRuntimeStatus = {
  codexBin: string;
  resolvedCodexBin: string | null;
  installed: boolean;
  version: string | null;
  detectionMessage: string | null;
  installCommand: string;
  projectRoot: string;
  dispatchCommandPreview: string;
  sessionScan: SessionScanState;
  projectAuthorization: {
    trustedInConfig: boolean;
    trustLevel: string | null;
    runtimeFullAccess: boolean;
  };
  apiConfig: {
    baseUrl: string | null;
    keyConfigured: boolean;
    keyMasked: string | null;
    updatedAt: string | null;
    usable: boolean;
    probeCheckedAt: string | null;
    probeMessage: string | null;
    probeTarget: string | null;
  };
  setupWizard: {
    required: boolean;
    reasons: string[];
    quickCommands: string[];
    steps: Array<{
      id: string;
      title: string;
      description: string;
      completed: boolean;
    }>;
  };
};

type ApiProbeResult = {
  success: boolean;
  checkedAt: string;
  message: string;
  target: string;
};

type ApiProbeFn = (input: { baseUrl: string; apiKey: string }) => Promise<ApiProbeResult>;

type SpawnInvocation = {
  command: string;
  args: string[];
};

export type CodexDispatchRuntimeContext = {
  ready: boolean;
  reason: string | null;
  codexBin: string;
  extraArgs: string[];
  env: NodeJS.ProcessEnv;
  authorization: {
    trustedInConfig: boolean;
    trustLevel: string | null;
    trustUpdated: boolean;
    warning: string | null;
  };
};

export class CodexCliRuntimeService {
  private readonly codexBin: string;
  private readonly projectRoot: string;
  private readonly codexHomePath: string;
  private readonly persistedConfigPath: string;
  private readonly codexConfigPath: string;
  private readonly installCommand: string[];
  private readonly dispatchAccessArgs: string[];
  private readonly apiProbe: ApiProbeFn;
  private persistedConfig: PersistedCodexRuntimeConfig = {
    apiBaseUrl: "",
    apiKey: "",
    updatedAt: "",
    apiProbePassed: false,
    apiProbeCheckedAt: "",
    apiProbeMessage: "",
    apiProbeTarget: ""
  };
  private runtimeSnapshot: RuntimeSnapshot = {
    installed: false,
    version: null,
    resolvedCodexBin: null,
    detectionMessage: null,
    trustedInConfig: false,
    trustLevel: null,
    statusCheckedAt: ""
  };
  private sessionScan: SessionScanState = {
    enabled: false,
    scannedAt: null,
    totalThreads: 0,
    totalFiles: 0,
    error: null
  };

  constructor(options: {
    codexBin: string;
    projectRoot: string;
    codexHomePath?: string;
    persistedConfigPath?: string;
    codexConfigPath?: string;
    installCommand?: string[];
    apiProbe?: ApiProbeFn;
  }) {
    this.codexBin = options.codexBin;
    this.projectRoot = resolve(options.projectRoot);
    this.codexHomePath = this.resolveWritableCodexHomePath(options.codexHomePath);
    this.persistedConfigPath = resolve(options.persistedConfigPath || resolve(this.projectRoot, "data", "codex-runtime-config.json"));
    this.codexConfigPath = resolve(options.codexConfigPath || resolve(this.codexHomePath, "config.toml"));
    this.installCommand = options.installCommand?.length
      ? options.installCommand
      : ["npm", "install", "-g", "@openai/codex"];
    this.apiProbe = options.apiProbe || this.probeApiAvailability.bind(this);
    this.dispatchAccessArgs = ["--sandbox", "danger-full-access", "--ask-for-approval", "never", "--cd", this.projectRoot];
    this.loadPersistedConfig();
  }

  initialize(input: { codexLocalSessionService?: CodexLocalSessionService | null } = {}) {
    this.scanSessions(input.codexLocalSessionService ?? null);
    this.refreshRuntimeSnapshot();
  }

  async probeAvailabilityAtStartup() {
    this.refreshRuntimeSnapshot();
    const next: PersistedCodexRuntimeConfig = {
      apiBaseUrl: this.persistedConfig.apiBaseUrl,
      apiKey: this.persistedConfig.apiKey,
      updatedAt: this.persistedConfig.updatedAt,
      apiProbePassed: this.persistedConfig.apiProbePassed,
      apiProbeCheckedAt: this.persistedConfig.apiProbeCheckedAt,
      apiProbeMessage: this.persistedConfig.apiProbeMessage,
      apiProbeTarget: this.persistedConfig.apiProbeTarget
    };

    const probe = await this.apiProbe({
      baseUrl: next.apiBaseUrl,
      apiKey: next.apiKey
    });
    next.apiProbePassed = probe.success;
    next.apiProbeCheckedAt = probe.checkedAt;
    next.apiProbeMessage = probe.message;
    next.apiProbeTarget = probe.target;
    this.persistedConfig = next;
    this.persistConfig();

    return this.getStatus({ refresh: true });
  }

  getStatus(input: { refresh?: boolean } = {}): CodexCliRuntimeStatus {
    if (input.refresh) {
      this.refreshRuntimeSnapshot();
    }

    const setupWizard = this.buildSetupWizard({
      apiUsable: this.persistedConfig.apiProbePassed
    });

    return {
      codexBin: this.codexBin,
      resolvedCodexBin: this.runtimeSnapshot.resolvedCodexBin,
      installed: this.runtimeSnapshot.installed,
      version: this.runtimeSnapshot.version,
      detectionMessage: this.runtimeSnapshot.detectionMessage,
      installCommand: this.installCommand.join(" "),
      projectRoot: this.projectRoot,
      dispatchCommandPreview: `${this.runtimeSnapshot.resolvedCodexBin || this.codexBin} ${this.dispatchAccessArgs.join(" ")} exec --json <prompt>`,
      sessionScan: this.sessionScan,
      projectAuthorization: {
        trustedInConfig: this.runtimeSnapshot.trustedInConfig,
        trustLevel: this.runtimeSnapshot.trustLevel,
        runtimeFullAccess: true
      },
      apiConfig: {
        baseUrl: this.persistedConfig.apiBaseUrl || null,
        keyConfigured: Boolean(this.persistedConfig.apiKey.trim()),
        keyMasked: this.maskKey(this.persistedConfig.apiKey),
        updatedAt: this.persistedConfig.updatedAt || null,
        usable: this.persistedConfig.apiProbePassed,
        probeCheckedAt: this.persistedConfig.apiProbeCheckedAt || null,
        probeMessage: this.persistedConfig.apiProbeMessage || null,
        probeTarget: this.persistedConfig.apiProbeTarget || null
      },
      setupWizard
    };
  }

  prepareDispatchContext(): CodexDispatchRuntimeContext {
    this.refreshRuntimeSnapshot();
    if (!this.runtimeSnapshot.installed) {
      return {
        ready: false,
        reason: "codex_cli_missing",
        codexBin: this.codexBin,
        extraArgs: this.dispatchAccessArgs,
        env: this.buildDispatchEnv(process.env),
        authorization: {
          trustedInConfig: this.runtimeSnapshot.trustedInConfig,
          trustLevel: this.runtimeSnapshot.trustLevel,
          trustUpdated: false,
          warning: null
        }
      };
    }

    let trustUpdated = false;
    let warning: string | null = null;
    if (!this.runtimeSnapshot.trustedInConfig) {
      try {
        trustUpdated = this.authorizeProjectTrust();
      } catch (error) {
        warning = error instanceof Error ? error.message : String(error);
      }
      this.refreshRuntimeSnapshot();
    }

    return {
      ready: true,
      reason: null,
      codexBin: this.runtimeSnapshot.resolvedCodexBin || this.codexBin,
      extraArgs: this.dispatchAccessArgs,
      env: this.buildDispatchEnv(process.env),
      authorization: {
        trustedInConfig: this.runtimeSnapshot.trustedInConfig,
        trustLevel: this.runtimeSnapshot.trustLevel,
        trustUpdated,
        warning
      }
    };
  }

  async saveApiConfig(input: { apiBaseUrl?: string | null; apiKey?: string | null }) {
    const next: PersistedCodexRuntimeConfig = {
      apiBaseUrl: this.persistedConfig.apiBaseUrl,
      apiKey: this.persistedConfig.apiKey,
      updatedAt: this.persistedConfig.updatedAt,
      apiProbePassed: this.persistedConfig.apiProbePassed,
      apiProbeCheckedAt: this.persistedConfig.apiProbeCheckedAt,
      apiProbeMessage: this.persistedConfig.apiProbeMessage,
      apiProbeTarget: this.persistedConfig.apiProbeTarget
    };

    if (input.apiBaseUrl !== undefined) {
      next.apiBaseUrl = (input.apiBaseUrl || "").trim();
    }
    if (input.apiKey !== undefined) {
      next.apiKey = (input.apiKey || "").trim();
    }
    next.updatedAt = new Date().toISOString();
    const probe = await this.apiProbe({
      baseUrl: next.apiBaseUrl,
      apiKey: next.apiKey
    });
    next.apiProbePassed = probe.success;
    next.apiProbeCheckedAt = probe.checkedAt;
    next.apiProbeMessage = probe.message;
    next.apiProbeTarget = probe.target;

    this.persistedConfig = next;
    this.persistConfig();
    return this.getStatus({ refresh: true });
  }

  async installCli(input: { inheritStdio?: boolean } = {}): Promise<InstallResult> {
    const [command, ...args] = this.installCommand;
    if (!command) {
      return {
        success: false,
        command: "",
        exitCode: 1,
        stdout: "",
        stderr: "Missing install command"
      };
    }

    const inheritStdio = Boolean(input.inheritStdio);
    const result = await new Promise<InstallResult>((resolvePromise) => {
      const child = spawn(command, args, {
        cwd: this.projectRoot,
        env: process.env,
        stdio: inheritStdio ? "inherit" : ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";

      if (!inheritStdio) {
        child.stdout?.on("data", (chunk) => {
          stdout += String(chunk);
        });
        child.stderr?.on("data", (chunk) => {
          stderr += String(chunk);
        });
      }

      child.on("error", (error) => {
        resolvePromise({
          success: false,
          command: this.installCommand.join(" "),
          exitCode: 1,
          stdout,
          stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`.trim()
        });
      });

      child.on("close", (code) => {
        resolvePromise({
          success: code === 0,
          command: this.installCommand.join(" "),
          exitCode: code ?? 1,
          stdout: stdout.trim(),
          stderr: stderr.trim()
        });
      });
    });

    this.refreshRuntimeSnapshot();
    return result;
  }

  scanSessions(service: CodexLocalSessionService | null) {
    if (!service) {
      this.sessionScan = {
        enabled: false,
        scannedAt: null,
        totalThreads: 0,
        totalFiles: 0,
        error: null
      };
      return this.sessionScan;
    }

    try {
      const snapshot = service.getSnapshot({
        limit: 10000,
        refresh: true
      });
      this.sessionScan = {
        enabled: true,
        scannedAt: snapshot.scannedAt,
        totalThreads: snapshot.totalThreads,
        totalFiles: snapshot.totalFiles,
        error: null
      };
    } catch (error) {
      this.sessionScan = {
        enabled: true,
        scannedAt: new Date().toISOString(),
        totalThreads: 0,
        totalFiles: 0,
        error: error instanceof Error ? error.message : String(error)
      };
    }

    return this.sessionScan;
  }

  emitStartupGuidance(input: { logger?: LoggerLike; systemConfigUrl?: string } = {}) {
    const status = this.getStatus({ refresh: true });
    const logger = input.logger;
    const systemConfigUrl = input.systemConfigUrl?.trim();
    if (!logger) {
      return status;
    }

    if (!status.installed) {
      logger.warn?.(
        {
          codexBin: status.codexBin,
          detectionMessage: status.detectionMessage,
          installCommand: status.installCommand,
          systemConfigUrl: systemConfigUrl || null
        },
        "Codex CLI not found, use web system panel to install and configure"
      );
    }

    if (!status.apiConfig.usable) {
      logger.info?.(
        {
          probeCheckedAt: status.apiConfig.probeCheckedAt,
          probeMessage: status.apiConfig.probeMessage,
          probeTarget: status.apiConfig.probeTarget,
          systemConfigUrl: systemConfigUrl || null
        },
        "Codex availability probe did not pass, open web system panel to review"
      );
    }

    return status;
  }

  authorizeProjectTrust() {
    const codexConfigPath = this.resolveCodexConfigPath();
    let content = "";
    if (existsSync(codexConfigPath)) {
      content = readFileSync(codexConfigPath, "utf8");
    }

    const sectionHeader = `[projects."${this.escapeTomlString(this.projectRoot)}"]`;
    const headerRegex = new RegExp(`^${this.escapeRegExp(sectionHeader)}\\s*$`, "m");
    let updated = false;

    if (headerRegex.test(content)) {
      const blockRegex = new RegExp(
        `(^${this.escapeRegExp(sectionHeader)}\\s*$)([\\s\\S]*?)(?=^\\[[^\\n]+\\]\\s*$|\\s*$)`,
        "m"
      );
      content = content.replace(blockRegex, (_matched, header: string, block: string) => {
        if (/^\s*trust_level\s*=.*$/m.test(block)) {
          const nextBlock = block.replace(/^\s*trust_level\s*=.*$/m, `trust_level = "trusted"`);
          if (nextBlock !== block) {
            updated = true;
          }
          return `${header}${nextBlock}`;
        }

        updated = true;
        const divider = block.endsWith("\n") || block.length === 0 ? "" : "\n";
        return `${header}${block}${divider}trust_level = "trusted"\n`;
      });
    } else {
      updated = true;
      const base = content.trimEnd();
      content = `${base.length > 0 ? `${base}\n\n` : ""}${sectionHeader}\ntrust_level = "trusted"\n`;
    }

    if (updated) {
      mkdirSync(dirname(codexConfigPath), { recursive: true });
      writeFileSync(codexConfigPath, content, "utf8");
    }
    return updated;
  }

  private loadPersistedConfig() {
    if (!existsSync(this.persistedConfigPath)) {
      return;
    }

    try {
      const parsed = JSON.parse(readFileSync(this.persistedConfigPath, "utf8")) as Partial<PersistedCodexRuntimeConfig>;
      this.persistedConfig = {
        apiBaseUrl: typeof parsed.apiBaseUrl === "string" ? parsed.apiBaseUrl.trim() : "",
        apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "",
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
        apiProbePassed: parsed.apiProbePassed === true,
        apiProbeCheckedAt: typeof parsed.apiProbeCheckedAt === "string" ? parsed.apiProbeCheckedAt : "",
        apiProbeMessage: typeof parsed.apiProbeMessage === "string" ? parsed.apiProbeMessage : "",
        apiProbeTarget: typeof parsed.apiProbeTarget === "string" ? parsed.apiProbeTarget : ""
      };
    } catch {
      this.persistedConfig = {
        apiBaseUrl: "",
        apiKey: "",
        updatedAt: "",
        apiProbePassed: false,
        apiProbeCheckedAt: "",
        apiProbeMessage: "",
        apiProbeTarget: ""
      };
    }
  }

  private persistConfig() {
    mkdirSync(dirname(this.persistedConfigPath), { recursive: true });
    writeFileSync(this.persistedConfigPath, `${JSON.stringify(this.persistedConfig, null, 2)}\n`, "utf8");
  }

  private refreshRuntimeSnapshot() {
    const { installed, version, resolvedCodexBin, detectionMessage } = this.detectCodexCli();
    const trustInfo = this.readProjectTrustInfo();
    this.runtimeSnapshot = {
      installed,
      version,
      resolvedCodexBin,
      detectionMessage,
      trustedInConfig: trustInfo.trusted,
      trustLevel: trustInfo.level,
      statusCheckedAt: new Date().toISOString()
    };
    return this.runtimeSnapshot;
  }

  private detectCodexCli() {
    if (process.platform === "win32") {
      const directVersion = this.tryReadWindowsShellCodexVersion();
      if (directVersion) {
        return {
          installed: true,
          version: directVersion,
          resolvedCodexBin: "codex",
          detectionMessage: null
        };
      }
    }

    const candidates = this.resolveCodexCandidates();
    for (const candidate of candidates) {
      const version = this.tryReadCodexVersion(candidate);
      if (!version) {
        continue;
      }
      return {
        installed: true,
        version,
        resolvedCodexBin: candidate,
        detectionMessage: null
      };
    }

    return {
      installed: false,
      version: null,
      resolvedCodexBin: null,
      detectionMessage: this.buildDetectionMessage()
    };
  }

  private tryReadWindowsShellCodexVersion() {
    try {
      const output = execFileSync("cmd.exe", ["/d", "/s", "/c", "codex --version"], {
        encoding: "utf8",
        env: this.buildCodexProcessEnv(process.env),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }).trim();
      return output.split(/\r?\n/)[0] || null;
    } catch {
      return null;
    }
  }

  private resolveCodexCandidates() {
    const candidates: string[] = [];
    const pushCandidate = (value: string | null | undefined) => {
      const text = (value || "").trim();
      if (!text || candidates.includes(text)) {
        return;
      }
      candidates.push(text);
    };

    pushCandidate(this.codexBin);
    const currentExt = extname(this.codexBin).toLowerCase();
    if (process.platform === "win32" && !currentExt) {
      pushCandidate(`${this.codexBin}.cmd`);
      pushCandidate(`${this.codexBin}.exe`);
      pushCandidate(`${this.codexBin}.bat`);
    }

    if (process.platform === "win32") {
      for (const item of this.resolveWindowsWhereCandidates()) {
        pushCandidate(item);
      }
      for (const item of this.resolveWindowsNpmGlobalCandidates()) {
        pushCandidate(item);
      }
    }

    return candidates;
  }

  private resolveWindowsWhereCandidates() {
    try {
      const output = execFileSync("cmd.exe", ["/d", "/s", "/c", "where codex"], {
        encoding: "utf8",
        env: this.buildCodexProcessEnv(process.env),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }).trim();
      if (!output) {
        return [];
      }
      return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => Boolean(line));
    } catch {
      return [];
    }
  }

  private resolveWindowsNpmGlobalCandidates() {
    const result: string[] = [];
    const pushPath = (value: string | null | undefined) => {
      const text = (value || "").trim();
      if (!text || !existsSync(text) || result.includes(text)) {
        return;
      }
      result.push(text);
    };

    const appData = process.env.APPDATA?.trim();
    if (appData) {
      pushPath(resolve(appData, "npm", "codex.cmd"));
      pushPath(resolve(appData, "npm", "codex.exe"));
    }

    const userProfile = process.env.USERPROFILE?.trim();
    if (userProfile) {
      pushPath(resolve(userProfile, "AppData", "Roaming", "npm", "codex.cmd"));
      pushPath(resolve(userProfile, "AppData", "Roaming", "npm", "codex.exe"));
    }

    const npmPrefix = this.resolveWindowsNpmPrefix();
    if (npmPrefix) {
      pushPath(resolve(npmPrefix, "codex.cmd"));
      pushPath(resolve(npmPrefix, "codex.exe"));
      pushPath(resolve(npmPrefix, "codex"));
    }

    return result;
  }

  private resolveWindowsNpmPrefix() {
    try {
      const output = execFileSync("cmd.exe", ["/d", "/s", "/c", "npm config get prefix"], {
        encoding: "utf8",
        env: this.buildCodexProcessEnv(process.env),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }).trim();
      if (!output) {
        return null;
      }
      if (/^undefined$/i.test(output) || /not recognized/i.test(output)) {
        return null;
      }
      return output.split(/\r?\n/)[0]?.trim() || null;
    } catch {
      return null;
    }
  }

  private tryReadCodexVersion(command: string) {
    try {
      if (process.platform === "win32") {
        const output = execFileSync(
          "cmd.exe",
          ["/d", "/s", "/c", `${this.quoteWindowsArg(command)} --version`],
          {
            encoding: "utf8",
            env: this.buildCodexProcessEnv(process.env),
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true
          }
        ).trim();
        return output.split(/\r?\n/)[0] || null;
      }

      const output = execFileSync(command, ["--version"], {
        encoding: "utf8",
        env: this.buildCodexProcessEnv(process.env),
        stdio: ["ignore", "pipe", "pipe"]
      }).trim();
      return output.split(/\r?\n/)[0] || null;
    } catch {
      return null;
    }
  }

  private readProjectTrustInfo() {
    const configPath = this.resolveCodexConfigPath();
    if (!existsSync(configPath)) {
      return {
        trusted: false,
        level: null as string | null
      };
    }

    try {
      const content = readFileSync(configPath, "utf8");
      const sectionHeader = `[projects."${this.escapeTomlString(this.projectRoot)}"]`;
      const lines = content.split(/\r?\n/);
      let inTargetSection = false;
      let level: string | null = null;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
          inTargetSection = trimmed === sectionHeader;
          continue;
        }

        if (!inTargetSection) {
          continue;
        }

        const matched = trimmed.match(/^trust_level\s*=\s*["']([^"']+)["']\s*$/);
        if (matched?.[1]) {
          level = matched[1].trim();
          break;
        }
      }

      return {
        trusted: level === "trusted",
        level
      };
    } catch {
      return {
        trusted: false,
        level: null as string | null
      };
    }
  }

  private buildDispatchEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...baseEnv
    };
    env.CODEX_HOME = this.codexHomePath;
    const resolvedBin = this.runtimeSnapshot.resolvedCodexBin;
    if (resolvedBin && isAbsolute(resolvedBin)) {
      const binDir = dirname(resolvedBin);
      const pathValue = env.PATH || env.Path || "";
      if (!this.pathContains(pathValue, binDir)) {
        const nextPath = pathValue ? `${binDir}${delimiter}${pathValue}` : binDir;
        env.PATH = nextPath;
        env.Path = nextPath;
      }
    }

    const baseUrl = this.persistedConfig.apiBaseUrl.trim();
    const apiKey = this.persistedConfig.apiKey.trim();

    if (baseUrl) {
      env.OPENAI_BASE_URL = baseUrl;
      env.OPENAI_API_BASE_URL = baseUrl;
    }

    if (apiKey) {
      env.OPENAI_API_KEY = apiKey;
    }

    return env;
  }

  private buildCodexProcessEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return {
      ...baseEnv,
      CODEX_HOME: this.codexHomePath
    };
  }

  private resolveCodexConfigPath() {
    return this.codexConfigPath;
  }

  private maskKey(value: string) {
    const text = value.trim();
    if (!text) {
      return null;
    }
    if (text.length <= 8) {
      return `${text.slice(0, 2)}***`;
    }
    return `${text.slice(0, 4)}***${text.slice(-4)}`;
  }

  private escapeTomlString(value: string) {
    return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  }

  private escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private pathContains(pathValue: string, targetDir: string) {
    if (!pathValue.trim()) {
      return false;
    }
    const expected = process.platform === "win32" ? targetDir.toLowerCase() : targetDir;
    const segments = pathValue
      .split(delimiter)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => (process.platform === "win32" ? item.toLowerCase() : item));
    return segments.includes(expected);
  }

  private quoteWindowsArg(value: string) {
    const sanitized = value.replace(/\r?\n/g, " ").replaceAll("%", "%%").replaceAll('"', '""');
    return `"${sanitized}"`;
  }

  private buildDetectionMessage() {
    if (process.platform !== "win32") {
      return "当前进程未检测到 codex 可执行文件，请在系统配置页面执行安装。";
    }
    return "Windows 检测到 codex 不在当前服务 PATH 中，请在系统配置页面安装，或将 codex.cmd 目录加入系统 PATH 后重启服务。";
  }

  private buildSetupWizard(input: { apiUsable: boolean }) {
    const installDone = this.runtimeSnapshot.installed;
    const trustDone = this.runtimeSnapshot.trustedInConfig;
    const apiDone = input.apiUsable;

    const steps = [
      {
        id: "install_cli",
        title: "安装 Codex CLI",
        description: `执行 ${this.installCommand.join(" ")} 后刷新状态`,
        completed: installDone
      },
      {
        id: "authorize_project",
        title: "授权当前项目目录",
        description: "点击“授权当前目录”，写入 trusted 配置",
        completed: trustDone
      },
      {
        id: "configure_api",
        title: "codex 可用检测",
        description: "网关服务启动时自动执行 codex exec 探测，返回探测 token 才视为完成",
        completed: apiDone
      }
    ];

    const reasons = steps.filter((item) => !item.completed).map((item) => item.id);

    return {
      required: reasons.length > 0,
      reasons,
      quickCommands: this.buildSetupQuickCommands(),
      steps
    };
  }

  private buildSetupQuickCommands() {
    const install = this.installCommand.join(" ");
    if (process.platform === "win32") {
      return [`echo $env:CODEX_HOME`, "codex --version", "where codex", install, "npm config get prefix"];
    }
    return ["echo $CODEX_HOME", "codex --version", "which codex", install];
  }

  private async probeApiAvailability(input: { baseUrl: string; apiKey: string }): Promise<ApiProbeResult> {
    const checkedAt = new Date().toISOString();
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
    const apiKey = input.apiKey.trim();

    this.refreshRuntimeSnapshot();
    const codexCommand = this.runtimeSnapshot.resolvedCodexBin || this.codexBin;
    if (!this.runtimeSnapshot.installed) {
      return {
        success: false,
        checkedAt,
        message: "Codex CLI 未安装，无法执行可用性探测",
        target: ""
      };
    }

    const token = "CODEX_MODEL_PROBE_OK";
    const prompt = `Reply with exactly ${token}. No other text.`;
    const args = ["exec", "--ephemeral", "--skip-git-repo-check", "-"];
    const spawnInvocation = this.resolveCodexSpawnInvocation(codexCommand, args);
    const target = `${codexCommand} ${args.join(" ")}`;
    const probeEnv = this.buildDispatchEnv(process.env);
    if (baseUrl) {
      probeEnv.OPENAI_BASE_URL = baseUrl;
      probeEnv.OPENAI_API_BASE_URL = baseUrl;
    }
    if (apiKey) {
      probeEnv.OPENAI_API_KEY = apiKey;
    }

    const result = await new Promise<{ exitCode: number; stdout: string; stderr: string; timeout: boolean }>((resolvePromise) => {
      const child = spawn(spawnInvocation.command, spawnInvocation.args, {
        cwd: this.projectRoot,
        env: probeEnv,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: process.platform === "win32"
      });
      this.writePromptToStdin(child.stdin, prompt);

      let stdout = "";
      let stderr = "";
      let resolved = false;
      const timer = setTimeout(() => {
        if (resolved) {
          return;
        }
        resolved = true;
        child.kill("SIGTERM");
        resolvePromise({
          exitCode: 124,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          timeout: true
        });
      }, 120000);

      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });

      child.on("error", (error) => {
        if (resolved) {
          return;
        }
        resolved = true;
        clearTimeout(timer);
        resolvePromise({
          exitCode: 1,
          stdout: stdout.trim(),
          stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`.trim(),
          timeout: false
        });
      });

      child.on("close", (code) => {
        if (resolved) {
          return;
        }
        resolved = true;
        clearTimeout(timer);
        resolvePromise({
          exitCode: code ?? 1,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          timeout: false
        });
      });
    });

    const matchedToken = result.stdout.toUpperCase().includes(token);
    if (result.exitCode === 0 && matchedToken) {
      return {
        success: true,
        checkedAt,
        message: "Codex 探测成功",
        target
      };
    }

    const reason = result.timeout
      ? "Codex 探测超时"
      : result.stderr || result.stdout || `exitCode=${result.exitCode}`;
    return {
      success: false,
      checkedAt,
      message: `Codex 探测失败：${reason}`,
      target
    };
  }

  private resolveWritableCodexHomePath(overridePath?: string) {
    const requested = (overridePath || process.env.CODEX_HOME || "").trim();
    if (requested) {
      const resolvedRequested = resolve(requested);
      if (this.ensureDirectoryWritable(resolvedRequested)) {
        return resolvedRequested;
      }
    }

    const homeCandidate = resolve(homedir(), ".codex");
    if (this.ensureDirectoryWritable(homeCandidate)) {
      return homeCandidate;
    }

    const fallback = resolve(this.projectRoot, "data", "codex-home");
    this.ensureDirectoryWritable(fallback);
    return fallback;
  }

  private ensureDirectoryWritable(path: string) {
    try {
      mkdirSync(path, {
        recursive: true
      });
      const probePath = resolve(path, ".write-probe.tmp");
      writeFileSync(probePath, "ok", "utf8");
      rmSync(probePath);
      return true;
    } catch {
      return false;
    }
  }

  private resolveCodexSpawnInvocation(commandBin: string, commandArgs: string[]): SpawnInvocation {
    if (process.platform !== "win32") {
      return {
        command: commandBin,
        args: commandArgs
      };
    }

    const ext = extname(commandBin).toLowerCase();
    const useCmdWrapper = ext === ".cmd" || ext === ".bat" || ext.length === 0;
    if (!useCmdWrapper) {
      return {
        command: commandBin,
        args: commandArgs
      };
    }

    const cmdline = this.buildWindowsCmdline(commandBin, commandArgs);
    return {
      command: "cmd.exe",
      args: ["/d", "/c", cmdline]
    };
  }

  private buildWindowsCmdline(commandBin: string, commandArgs: string[]) {
    const commandToken = this.isBareWindowsCommand(commandBin) ? commandBin : this.quoteWindowsArg(commandBin);
    return [commandToken, ...commandArgs.map((arg) => this.toWindowsCmdArg(arg))].join(" ");
  }

  private isBareWindowsCommand(value: string) {
    return /^[A-Za-z0-9_.-]+$/.test(value);
  }

  private toWindowsCmdArg(value: string) {
    if (!this.needsWindowsQuote(value)) {
      return value;
    }
    return this.quoteWindowsArg(value);
  }

  private needsWindowsQuote(value: string) {
    return /[\s"&|<>^()%!]/.test(value);
  }

  private writePromptToStdin(
    stdin: {
      write: (chunk: string) => void;
      end: () => void;
    } | null
      | undefined,
    prompt: string
  ) {
    if (!stdin) {
      return;
    }
    try {
      stdin.write(prompt.endsWith("\n") ? prompt : `${prompt}\n`);
      stdin.end();
    } catch {
      try {
        stdin.end();
      } catch {
        // ignore stdin cleanup failures
      }
    }
  }
}
