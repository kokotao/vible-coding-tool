/**
 * @description 系统配置路由，提供 Codex CLI 运行状态、安装与 API 配置能力
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-28 00:00
 */
import type { FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import { z } from "zod";
import { CodexCliRuntimeService } from "../modules/codex/codex-cli-runtime-service";
import { AppError } from "../lib/errors";

const codexRuntimeConfigSchema = z.object({
  apiBaseUrl: z.string().trim().max(1024).nullable().optional(),
  apiKey: z.string().trim().max(4096).nullable().optional(),
  workspaceRoot: z.string().trim().max(4096).nullable().optional()
});

const codexInstallSchema = z.object({
  confirm: z.boolean().optional()
});

const pickWorkspaceRootSchema = z.object({
  startPath: z.string().trim().max(4096).optional()
});

export function registerSystemRoutes(app: FastifyInstance, codexCliRuntimeService: CodexCliRuntimeService) {
  app.get("/api/system/codex-cli/status", async () => {
    return codexCliRuntimeService.getStatus({
      refresh: true
    });
  });

  app.put<{ Body: unknown }>("/api/system/codex-cli/config", async (request) => {
    const payload = codexRuntimeConfigSchema.parse(request.body);
    return codexCliRuntimeService.saveApiConfig({
      apiBaseUrl: payload.apiBaseUrl ?? undefined,
      apiKey: payload.apiKey ?? undefined,
      workspaceRoot: payload.workspaceRoot ?? undefined
    });
  });

  app.post<{ Body: unknown }>("/api/system/codex-cli/install", async (request, reply) => {
    const payload = codexInstallSchema.parse(request.body || {});
    if (!payload.confirm) {
      reply.status(400);
      return {
        code: "CONFIRM_REQUIRED",
        message: "Install Codex CLI requires confirm=true"
      };
    }

    const install = await codexCliRuntimeService.installCli({
      inheritStdio: false
    });
    const status = codexCliRuntimeService.getStatus({
      refresh: true
    });
    if (!install.success) {
      reply.status(500);
    }

    return {
      ...install,
      status
    };
  });

  app.post("/api/system/codex-cli/authorize-project", async () => {
    const updated = codexCliRuntimeService.authorizeProjectTrust();
    return {
      updated,
      status: codexCliRuntimeService.getStatus({
        refresh: true
      })
    };
  });

  app.post<{ Body: unknown }>("/api/system/workspace-root/pick", async (request) => {
    const payload = pickWorkspaceRootSchema.parse(request.body || {});
    const pickedPath = await pickDirectoryPath(payload.startPath);
    if (!pickedPath) {
      throw new AppError("DIRECTORY_PICKER_CANCELLED", 409, "Directory selection cancelled");
    }
    return {
      path: pickedPath
    };
  });
}

async function pickDirectoryPath(startPath?: string): Promise<string | null> {
  const platform = process.platform;
  if (platform === "win32") {
    return await pickDirectoryPathOnWindows(startPath);
  }
  if (platform === "darwin") {
    return await pickDirectoryPathOnMac();
  }
  return await pickDirectoryPathOnLinux(startPath);
}

async function pickDirectoryPathOnWindows(startPath?: string): Promise<string | null> {
  const selectedPathScript = startPath?.trim()
    ? `$dialog.SelectedPath = '${startPath.trim().replaceAll("'", "''")}'`
    : "";
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "请选择工作区主目录"
$dialog.ShowNewFolderButton = $true
${selectedPathScript}
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
}
`.trim();

  const result = await runExecFile("powershell", ["-NoProfile", "-STA", "-Command", script]);
  if (result.exitCode !== 0) {
    throw new AppError("DIRECTORY_PICKER_UNAVAILABLE", 500, result.stderr || "Failed to open directory picker");
  }

  const text = result.stdout.trim();
  return text ? text : null;
}

async function pickDirectoryPathOnMac(): Promise<string | null> {
  const script = 'try\nPOSIX path of (choose folder with prompt "请选择工作区主目录")\non error number -128\nreturn ""\nend try';
  const result = await runExecFile("osascript", ["-e", script]);
  if (result.exitCode !== 0) {
    throw new AppError("DIRECTORY_PICKER_UNAVAILABLE", 500, result.stderr || "Failed to open directory picker");
  }

  const text = result.stdout.trim().replace(/[\\\/]+$/, "");
  return text ? text : null;
}

async function pickDirectoryPathOnLinux(startPath?: string): Promise<string | null> {
  const base = startPath?.trim() || "";
  const args = ["--file-selection", "--directory", "--title=请选择工作区主目录"];
  if (base) {
    args.push(`--filename=${base.endsWith("/") ? base : `${base}/`}`);
  }
  const result = await runExecFile("zenity", args);
  if (result.exitCode === 1) {
    return null;
  }
  if (result.exitCode !== 0) {
    throw new AppError("DIRECTORY_PICKER_UNAVAILABLE", 500, result.stderr || "Failed to open directory picker");
  }

  const text = result.stdout.trim();
  return text ? text : null;
}

async function runExecFile(command: string, args: string[]) {
  return await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolvePromise) => {
    execFile(command, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (!error) {
        resolvePromise({
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          exitCode: 0
        });
        return;
      }

      const exitCode =
        typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code ?? 1) : 1;
      resolvePromise({
        stdout: String(stdout || ""),
        stderr: String(stderr || error.message || ""),
        exitCode
      });
    });
  });
}
