import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadModelCatalogServiceWithChildProcessMock(execFileSyncImpl: (...args: any[]) => string) {
  vi.resetModules();
  vi.doMock("node:child_process", () => ({
    execFileSync: execFileSyncImpl
  }));
  return (await import("../../src/modules/codex/codex-model-catalog-service")).CodexModelCatalogService;
}

describe("codex model catalog service", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unmock("node:child_process");
  });

  it("uses cmd.exe wrapper on windows when codex bin has no extension", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const execMock = vi.fn((file: string, args?: readonly string[]) => {
      const argv = Array.isArray(args) ? args : [];
      if (file !== "cmd.exe") {
        throw new Error(`unexpected command: ${file} ${argv.join(" ")}`);
      }
      return JSON.stringify({
        models: [
          {
            slug: "gpt-5.4",
            display_name: "GPT-5.4"
          }
        ]
      });
    });
    const CodexModelCatalogService = await loadModelCatalogServiceWithChildProcessMock(execMock);

    const service = new CodexModelCatalogService({
      codexBin: "codex"
    });
    const result = service.listModels({ refresh: true });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.slug).toBe("gpt-5.4");
    expect(execMock).toHaveBeenCalledWith(
      "cmd.exe",
      expect.arrayContaining(["/d", "/s", "/c"]),
      expect.objectContaining({
        windowsHide: true
      })
    );
  });

  it("reads default model from USERPROFILE fallback when HOME is empty", async () => {
    const homeRoot = mkdtempSync(join(tmpdir(), "codex-model-home-"));
    const codexHome = join(homeRoot, ".codex");
    const configPath = join(codexHome, "config.toml");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(configPath, 'model = "gpt-5.4"\n', "utf8");

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = "";
    process.env.USERPROFILE = homeRoot;

    const execMock = vi.fn(() =>
      JSON.stringify({
        models: [
          {
            slug: "gpt-5.4",
            display_name: "GPT-5.4"
          }
        ]
      })
    );
    const CodexModelCatalogService = await loadModelCatalogServiceWithChildProcessMock(execMock);

    try {
      const service = new CodexModelCatalogService({
        codexBin: "codex",
        codexHomePath: codexHome
      });
      const result = service.listModels({ refresh: true });

      expect(result.defaultModel).toBe("gpt-5.4");
      expect(execMock).toHaveBeenCalled();
      const firstExecCall = execMock.mock.calls[0] as unknown as
        | [string, readonly string[], { env?: NodeJS.ProcessEnv }]
        | undefined;
      const execOptions = firstExecCall?.[2];
      expect(execOptions?.env?.CODEX_HOME).toBe(codexHome);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = originalUserProfile;
      }
      rmSync(homeRoot, { recursive: true, force: true });
    }
  });
});
