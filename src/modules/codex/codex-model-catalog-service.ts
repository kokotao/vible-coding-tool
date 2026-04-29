/**
 * @description 通过 Codex CLI 获取可用模型目录，并提供默认模型和按 slug 查询能力
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-27 21:40
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { extname, resolve } from "node:path";
import { AppError } from "../../lib/errors";

export type CodexModelCatalogRecord = {
  slug: string;
  displayName: string;
  description: string;
  defaultReasoningLevel: string | null;
  supportedReasoningLevels: Array<{
    effort: string;
    description: string;
  }>;
  visibility: string | null;
  supportedInApi: boolean;
  priority: number | null;
};

type CodexModelCatalogPayload = {
  models?: Array<Record<string, unknown>>;
};

export class CodexModelCatalogService {
  private cache: {
    loadedAtMs: number;
    defaultModel: string | null;
    items: CodexModelCatalogRecord[];
  } | null = null;

  constructor(
    private readonly options: {
      codexBin: string;
      configPath?: string;
      codexHomePath?: string;
      cacheTtlMs?: number;
    }
  ) {}

  listModels(input: { refresh?: boolean } = {}) {
    const cacheTtlMs = this.options.cacheTtlMs ?? 60_000;
    const now = Date.now();
    if (!input.refresh && this.cache && now - this.cache.loadedAtMs < cacheTtlMs) {
      return this.cache;
    }

    const parsed = this.loadCatalog();
    this.cache = {
      loadedAtMs: now,
      defaultModel: this.readDefaultModel(),
      items: parsed
    };
    return this.cache;
  }

  findBySlug(slug: string) {
    const normalized = slug.trim();
    if (!normalized) {
      return null;
    }

    const catalog = this.listModels().items;
    const lower = normalized.toLowerCase();
    return (
      catalog.find((item) => item.slug.toLowerCase() === lower) ||
      catalog.find((item) => item.displayName.toLowerCase() === lower) ||
      catalog.find((item) => item.slug.toLowerCase().includes(lower)) ||
      catalog.find((item) => item.displayName.toLowerCase().includes(lower)) ||
      null
    );
  }

  private loadCatalog() {
    const commands = [
      [this.options.codexBin, ["debug", "models"]],
      [this.options.codexBin, ["debug", "models", "--bundled"]]
    ] as const;

    let lastError: unknown = null;
    for (const [bin, args] of commands) {
      try {
        const raw = this.execCodexCommand(bin, [...args]);

        const payload = JSON.parse(raw) as CodexModelCatalogPayload;
        const models = Array.isArray(payload.models) ? payload.models : [];

        return models
          .map((model) => this.mapModel(model))
          .filter((model): model is CodexModelCatalogRecord => Boolean(model))
          .sort((left, right) => {
            const leftPriority = left.priority ?? -1;
            const rightPriority = right.priority ?? -1;
            if (rightPriority !== leftPriority) {
              return rightPriority - leftPriority;
            }
            return left.slug.localeCompare(right.slug);
          });
      } catch (error) {
        lastError = error;
      }
    }

    throw new AppError(
      "CODEX_MODEL_CATALOG_UNAVAILABLE",
      503,
      `Failed to load Codex model catalog: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    );
  }

  private mapModel(model: Record<string, unknown>): CodexModelCatalogRecord | null {
    const slug = this.stringValue(model.slug) || this.stringValue(model.display_name) || "";
    const displayName = this.stringValue(model.display_name) || slug;

    if (!slug || !displayName) {
      return null;
    }

    const supportedReasoningLevels = Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels
          .map((item) => {
            if (!item || typeof item !== "object") {
              return null;
            }
            const record = item as Record<string, unknown>;
            const effort = this.stringValue(record.effort);
            const description = this.stringValue(record.description);
            if (!effort || !description) {
              return null;
            }
            return {
              effort,
              description
            };
          })
          .filter((item): item is { effort: string; description: string } => Boolean(item))
      : [];

    return {
      slug,
      displayName,
      description: this.stringValue(model.description) || "",
      defaultReasoningLevel: this.stringValue(model.default_reasoning_level),
      supportedReasoningLevels,
      visibility: this.stringValue(model.visibility),
      supportedInApi: Boolean(model.supported_in_api),
      priority: typeof model.priority === "number" ? model.priority : null
    };
  }

  private readDefaultModel() {
    const configPath = this.options.configPath ?? resolve(this.resolveCodexHomePath(), "config.toml");
    try {
      const content = readFileSync(configPath, "utf8");
      const match = content.match(/^\s*model\s*=\s*["']([^"']+)["']\s*$/m);
      return match?.[1]?.trim() || null;
    } catch {
      return null;
    }
  }

  private stringValue(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
  }

  private execCodexCommand(bin: string, args: string[]) {
    const env = this.buildCodexEnv(process.env);
    const baseOptions = {
      encoding: "utf8" as BufferEncoding,
      env,
      stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024
    };

    if (process.platform === "win32" && this.shouldUseCmdWrapper(bin)) {
      const cmdline = this.buildWindowsCmdline(bin, args);
      return execFileSync("cmd.exe", ["/d", "/s", "/c", cmdline], {
        ...baseOptions,
        windowsHide: true
      }).trim();
    }

    return execFileSync(bin, args, baseOptions).trim();
  }

  private shouldUseCmdWrapper(commandBin: string) {
    const ext = extname(commandBin).toLowerCase();
    return ext === ".cmd" || ext === ".bat" || ext.length === 0;
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

  private quoteWindowsArg(value: string) {
    const sanitized = value.replace(/\r?\n/g, " ").replaceAll("%", "%%").replaceAll('"', '""');
    return `"${sanitized}"`;
  }

  private buildCodexEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return {
      ...baseEnv,
      CODEX_HOME: this.resolveCodexHomePath()
    };
  }

  private resolveCodexHomePath() {
    const configured = (this.options.codexHomePath || process.env.CODEX_HOME || "").trim();
    if (configured) {
      return resolve(configured);
    }

    const home =
      process.env.HOME?.trim() ||
      process.env.USERPROFILE?.trim() ||
      `${process.env.HOMEDRIVE || ""}${process.env.HOMEPATH || ""}`.trim() ||
      homedir();
    return resolve(home, ".codex");
  }
}
