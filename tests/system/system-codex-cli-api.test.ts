import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/app";
import { CodexCliRuntimeService } from "../../src/modules/codex/codex-cli-runtime-service";
import { createSqliteDatabase, migrateDatabase } from "../../src/storage/sqlite";

describe("system codex cli api", () => {
  it("supports status query, api config save, install trigger and project authorization", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "system-codex-cli-"));
    const codexConfigPath = join(workspaceRoot, ".codex", "config.toml");
    const persistedConfigPath = join(workspaceRoot, "data", "codex-runtime-config.json");

    const runtimeService = new CodexCliRuntimeService({
      codexBin: "__missing_codex_binary__",
      projectRoot: workspaceRoot,
      codexConfigPath,
      persistedConfigPath,
      installCommand: ["node", "-e", "process.exit(0)"],
      apiProbe: async ({ baseUrl }) => ({
        success: true,
        checkedAt: "2026-04-28T06:00:00.000Z",
        message: "probe ok",
        target: `${baseUrl}/models`
      })
    });

    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);
    const app = buildApp({
      db,
      codexCliRuntimeService: runtimeService,
      env: {
        databasePath: ":memory:",
        logLevel: "silent"
      }
    });

    try {
      const statusResponse = await app.inject({
        method: "GET",
        url: "/api/system/codex-cli/status"
      });
      expect(statusResponse.statusCode).toBe(200);
      expect(statusResponse.json()).toEqual(
        expect.objectContaining({
          codexBin: "__missing_codex_binary__",
          workspaceConfigured: false,
          setupWizard: expect.objectContaining({
            required: true,
            steps: expect.any(Array),
            quickCommands: expect.any(Array)
          })
        })
      );

      const saveResponse = await app.inject({
        method: "PUT",
        url: "/api/system/codex-cli/config",
        payload: {
          apiBaseUrl: "https://gateway.example.com/v1",
          apiKey: "sk-test-1234567890",
          workspaceRoot
        }
      });
      expect(saveResponse.statusCode).toBe(200);
      expect(saveResponse.json()).toEqual(
        expect.objectContaining({
          apiConfig: expect.objectContaining({
            baseUrl: "https://gateway.example.com/v1",
            keyConfigured: true,
            usable: true
          }),
          workspaceRoot,
          workspaceConfigured: true
        })
      );
      expect(saveResponse.json().apiConfig.keyMasked).toContain("***");

      const installReject = await app.inject({
        method: "POST",
        url: "/api/system/codex-cli/install",
        payload: {}
      });
      expect(installReject.statusCode).toBe(400);
      expect(installReject.json()).toEqual({
        code: "CONFIRM_REQUIRED",
        message: "Install Codex CLI requires confirm=true"
      });

      const installConfirm = await app.inject({
        method: "POST",
        url: "/api/system/codex-cli/install",
        payload: {
          confirm: true
        }
      });
      expect(installConfirm.statusCode).toBe(200);
      expect(installConfirm.json()).toEqual(
        expect.objectContaining({
          success: true,
          exitCode: 0
        })
      );

      const authorizeResponse = await app.inject({
        method: "POST",
        url: "/api/system/codex-cli/authorize-project"
      });
      expect(authorizeResponse.statusCode).toBe(200);
      expect(authorizeResponse.json()).toEqual(
        expect.objectContaining({
          status: expect.objectContaining({
            projectAuthorization: expect.objectContaining({
              trustedInConfig: true,
              trustLevel: "trusted"
            })
          })
        })
      );

      const codexConfigContent = readFileSync(codexConfigPath, "utf8");
      expect(codexConfigContent).toContain(`[projects."${workspaceRoot.replaceAll("\\", "\\\\")}"]`);
      expect(codexConfigContent).toContain('trust_level = "trusted"');
    } finally {
      await app.close();
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
