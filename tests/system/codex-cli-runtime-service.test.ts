import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadRuntimeServiceWithChildProcessMock(
  execFileSyncImpl: (file: string, args?: readonly string[]) => string,
  spawnImpl?: (...args: any[]) => any
) {
  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    execFileSync: execFileSyncImpl,
    spawn: (spawnImpl || vi.fn()) as any
  }));
  return (await import("../../src/modules/codex/codex-cli-runtime-service")).CodexCliRuntimeService;
}

describe("codex cli runtime service", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unmock("node:child_process");
    vi.useRealTimers();
  });

  it("prefers direct 'codex --version' probing on windows", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "codex-runtime-win-"));
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    const CodexCliRuntimeService = await loadRuntimeServiceWithChildProcessMock((file: string, args?: readonly string[]) => {
      const argv = Array.isArray(args) ? args : [];
      if (file === "cmd.exe" && argv.includes("codex --version")) {
        return "codex-cli 0.125.0\n";
      }
      throw new Error("not found");
    });

    try {
      const runtimeService = new CodexCliRuntimeService({
        codexBin: "__missing_codex_binary__",
        projectRoot: workspaceRoot
      });

      const status = runtimeService.getStatus({ refresh: true });
      expect(status.installed).toBe(true);
      expect(status.version).toBe("codex-cli 0.125.0");
      expect(status.resolvedCodexBin).toBe("codex");
      expect(status.detectionMessage).toBeNull();
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("falls back to candidate probing when direct windows probe fails", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "codex-runtime-fallback-"));
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    const CodexCliRuntimeService = await loadRuntimeServiceWithChildProcessMock((file: string, args?: readonly string[]) => {
      const argv = Array.isArray(args) ? args : [];
      if (file !== "cmd.exe") {
        throw new Error("not found");
      }
      if (argv.includes("codex --version")) {
        throw new Error("direct probe failed");
      }
      const rawCommand = argv[argv.length - 1] || "";
      if (rawCommand.includes("codex.cmd") && rawCommand.includes("--version")) {
        return "codex-cli 0.126.0\n";
      }
      throw new Error("not found");
    });

    try {
      const runtimeService = new CodexCliRuntimeService({
        codexBin: "C:\\tools\\codex.cmd",
        projectRoot: workspaceRoot
      });

      const status = runtimeService.getStatus({ refresh: true });
      expect(status.installed).toBe(true);
      expect(status.version).toBe("codex-cli 0.126.0");
      expect(status.resolvedCodexBin).toBe("C:\\tools\\codex.cmd");
      expect(status.detectionMessage).toBeNull();
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("runs availability probe at startup and updates setup step3 by probe result", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "codex-runtime-probe-"));
    const CodexCliRuntimeService = await loadRuntimeServiceWithChildProcessMock(() => {
      throw new Error("not found");
    });

    try {
      const runtimeService = new CodexCliRuntimeService({
        codexBin: "__missing_codex_binary__",
        projectRoot: workspaceRoot,
        apiProbe: async () => ({
          success: true,
          checkedAt: "2026-04-28T07:00:00.000Z",
          message: "probe ok",
          target: "codex exec --ephemeral --skip-git-repo-check"
        })
      });

      const status = await runtimeService.probeAvailabilityAtStartup();
      expect(status.apiConfig.usable).toBe(true);
      const step3 = status.setupWizard.steps.find((item) => item.id === "configure_api");
      expect(step3?.completed).toBe(true);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("waits 120 seconds before timing out the availability probe", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "codex-runtime-timeout-"));
    const persistedConfigPath = join(workspaceRoot, "codex-runtime-config.json");
    writeFileSync(
      persistedConfigPath,
      JSON.stringify(
        {
          apiBaseUrl: "https://gateway.example.com/v1",
          apiKey: "sk-test-1234567890",
          workspaceRoot,
          updatedAt: "2026-04-28T07:00:00.000Z",
          apiProbePassed: false,
          apiProbeCheckedAt: "",
          apiProbeMessage: "",
          apiProbeTarget: ""
        },
        null,
        2
      )
    );

    type ProbeSpawnChild = EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    let spawnedChild: ProbeSpawnChild | null = null;
    let killMock: ReturnType<typeof vi.fn> | null = null;
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as ProbeSpawnChild;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      killMock = vi.fn();
      (child as ProbeSpawnChild & { kill: ReturnType<typeof vi.fn> }).kill = killMock;
      spawnedChild = child;
      return child;
    });

    const CodexCliRuntimeService = await loadRuntimeServiceWithChildProcessMock((file: string, args?: readonly string[]) => {
      const argv = Array.isArray(args) ? args : [];
      if (file === "codex" && argv.includes("--version")) {
        return "codex-cli 0.125.0\n";
      }
      throw new Error(`unexpected command: ${file} ${argv.join(" ")}`);
    }, spawnImpl as (...args: any[]) => any);

    try {
      const runtimeService = new CodexCliRuntimeService({
        codexBin: "codex",
        projectRoot: workspaceRoot,
        persistedConfigPath
      });

      let resolvedStatus: Awaited<ReturnType<typeof runtimeService.probeAvailabilityAtStartup>> | null = null;
      const probePromise = runtimeService.probeAvailabilityAtStartup().then((status) => {
        resolvedStatus = status;
        return status;
      });

      await vi.advanceTimersByTimeAsync(119_000);
      const activeChild = spawnedChild;
      expect(spawnImpl).toHaveBeenCalledTimes(1);
      if (!activeChild) {
        throw new Error("expected probe child to be spawned");
      }
      expect(killMock).not.toBeNull();
      expect(killMock).not.toHaveBeenCalled();
      expect(resolvedStatus).toBeNull();

      await vi.advanceTimersByTimeAsync(1_000);
      const status = await probePromise;

      expect(killMock).toHaveBeenCalledWith("SIGTERM");
      expect(status.apiConfig.usable).toBe(false);
      expect(status.apiConfig.probeMessage).toBe("Codex 探测失败：Codex 探测超时");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("injects writable CODEX_HOME into startup probe env", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "codex-runtime-home-env-"));
    const codexHomePath = join(workspaceRoot, ".codex-home");
    const persistedConfigPath = join(workspaceRoot, "codex-runtime-config.json");
    writeFileSync(
      persistedConfigPath,
      JSON.stringify(
        {
          apiBaseUrl: "",
          apiKey: "",
          workspaceRoot,
          updatedAt: "2026-04-28T07:00:00.000Z",
          apiProbePassed: false,
          apiProbeCheckedAt: "",
          apiProbeMessage: "",
          apiProbeTarget: ""
        },
        null,
        2
      )
    );

    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();

      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("CODEX_MODEL_PROBE_OK"));
        child.emit("close", 0);
      });
      return child;
    });

    const CodexCliRuntimeService = await loadRuntimeServiceWithChildProcessMock((file: string, args?: readonly string[]) => {
      const argv = Array.isArray(args) ? args : [];
      if (file === "codex" && argv.includes("--version")) {
        return "codex-cli 0.130.0\n";
      }
      throw new Error(`unexpected command: ${file} ${argv.join(" ")}`);
    }, spawnImpl as (...args: any[]) => any);

    try {
      const runtimeService = new CodexCliRuntimeService({
        codexBin: "codex",
        projectRoot: workspaceRoot,
        codexHomePath,
        persistedConfigPath
      });

      const status = await runtimeService.probeAvailabilityAtStartup();
      expect(status.apiConfig.usable).toBe(true);
      expect(spawnImpl).toHaveBeenCalledTimes(1);
      expect(spawnImpl).toHaveBeenCalledWith(
        "codex",
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({
            CODEX_HOME: codexHomePath
          })
        })
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("uses cmd wrapper for startup probe on windows when resolved codex command has no extension", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "codex-runtime-win-probe-"));
    const persistedConfigPath = join(workspaceRoot, "codex-runtime-config.json");
    writeFileSync(
      persistedConfigPath,
      JSON.stringify(
        {
          apiBaseUrl: "",
          apiKey: "",
          workspaceRoot,
          updatedAt: "2026-04-28T07:00:00.000Z",
          apiProbePassed: false,
          apiProbeCheckedAt: "",
          apiProbeMessage: "",
          apiProbeTarget: ""
        },
        null,
        2
      )
    );
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();

      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("CODEX_MODEL_PROBE_OK"));
        child.emit("close", 0);
      });
      return child;
    });

    const CodexCliRuntimeService = await loadRuntimeServiceWithChildProcessMock((file: string, args?: readonly string[]) => {
      const argv = Array.isArray(args) ? args : [];
      if (file === "cmd.exe" && argv.includes("codex --version")) {
        return "codex-cli 0.130.0\n";
      }
      throw new Error(`unexpected command: ${file} ${argv.join(" ")}`);
    }, spawnImpl as (...args: any[]) => any);

    try {
      const runtimeService = new CodexCliRuntimeService({
        codexBin: "codex",
        projectRoot: workspaceRoot,
        persistedConfigPath
      });

      const status = await runtimeService.probeAvailabilityAtStartup();
      expect(status.apiConfig.usable).toBe(true);
      expect(spawnImpl).toHaveBeenCalledTimes(1);
      expect(spawnImpl).toHaveBeenCalledWith(
        "cmd.exe",
        expect.arrayContaining(["/d", "/c"]),
        expect.objectContaining({
          windowsHide: true
        })
      );

      const firstCall = spawnImpl.mock.calls[0] as unknown[] | undefined;
      const cmdArgs = (firstCall?.[1] as string[] | undefined) || [];
      expect(cmdArgs[2]).toContain("codex");
      expect(cmdArgs[2]).toContain("exec");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
