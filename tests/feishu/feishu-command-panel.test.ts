import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFeishuModelListCard,
  parseFeishuPanelActionValue,
  parseFeishuPanelCommand
} from "../../src/modules/feishu/feishu-command-panel";
import { FeishuCommandPanelService } from "../../src/modules/feishu/feishu-command-panel-service";
import { FeishuPanelContextRepository } from "../../src/storage/repositories/feishu-panel-context-repository";
import { createSqliteDatabase, migrateDatabase } from "../../src/storage/sqlite";

function parseCard(cardJson: string) {
  return JSON.parse(cardJson) as {
    elements?: Array<{
      tag?: string;
      content?: string;
      actions?: Array<{
        text?: { content?: string };
        value?: Record<string, unknown>;
      }>;
    }>;
  };
}

function collectButtons(cardJson: string) {
  const card = parseCard(cardJson);
  return (card.elements || [])
    .filter((element) => element.tag === "action")
    .flatMap((element) => element.actions || []);
}

function normalizeCardText(text: string) {
  return text.replace(/<[^>]+>/g, "").replace(/\*\*/g, "").replace(/[：:]\s+/g, "：");
}

describe("feishu command panel model selection", () => {
  let db: ReturnType<typeof createSqliteDatabase>;
  let contextRepository: FeishuPanelContextRepository;

  beforeEach(() => {
    db = createSqliteDatabase(":memory:");
    migrateDatabase(db);
    contextRepository = new FeishuPanelContextRepository(db);
  });

  it("parses model card actions with reasoning levels", () => {
    const parsed = parseFeishuPanelActionValue({
      panelAction: "select_model",
      selector: "gpt-5.4",
      reasoningLevel: "high"
    });

    expect(parsed).toEqual({
      actionType: "select_model",
      selector: "gpt-5.4",
      reasoningLevel: "high"
    });
  });

  it("parses project/session/model commands separated by spaces", () => {
    expect(parseFeishuPanelCommand("选择项目 /tmp/demo")).toEqual({
      actionType: "select_project",
      selector: "/tmp/demo"
    });
    expect(parseFeishuPanelCommand("选择session 019dca61-0d90-7f01-b1b0-f1bb79eb955e")).toEqual({
      actionType: "select_session",
      selector: "019dca61-0d90-7f01-b1b0-f1bb79eb955e"
    });
    expect(parseFeishuPanelCommand("选择模型 gpt-5.4")).toEqual({
      actionType: "select_model",
      selector: "gpt-5.4"
    });
    expect(parseFeishuPanelCommand("选择项目")).toBeNull();
  });

  it("renders reasoning buttons on the model list card", () => {
    const card = buildFeishuModelListCard({
      context: {
        openId: "ou_test",
        currentView: "model_list",
        selectedProjectName: null,
        selectedProjectPath: null,
        selectedThreadId: null,
        selectedSessionTitle: null,
        selectedModelSlug: "gpt-5.4",
        selectedModelName: "GPT-5.4",
        selectedReasoningLevel: "high",
        pendingComposeMode: null,
        lastAction: null,
        updatedAt: new Date().toISOString()
      },
      models: [
        {
          slug: "gpt-5.4",
          displayName: "GPT-5.4",
          description: "Model with multiple reasoning levels",
          defaultReasoningLevel: "medium",
          supportedReasoningLevels: [
            { effort: "low", description: "Fastest" },
            { effort: "medium", description: "Balanced" },
            { effort: "high", description: "Careful" },
            { effort: "xhigh", description: "Deep" }
          ],
          visibility: null,
          supportedInApi: true,
          priority: 10
        }
      ],
      defaultModel: "gpt-5.4"
    });

    const parsedCard = parseCard(card);
    const textPayloads = (parsedCard.elements || [])
      .filter((element) => element.tag === "markdown")
      .map((element) => element.content || "");

    const normalizedText = normalizeCardText(textPayloads.join("\n"));
    expect(normalizedText).toContain("支持推理");
    expect(normalizedText).toContain("默认推理：中");

    const buttons = collectButtons(card);
    expect(buttons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.objectContaining({ content: "高（已选）" }),
          value: expect.objectContaining({
            panelAction: "select_model",
            selector: "gpt-5.4",
            reasoningLevel: "high"
          })
        }),
        expect.objectContaining({
          text: expect.objectContaining({ content: "低" }),
          value: expect.objectContaining({
            reasoningLevel: "low"
          })
        }),
        expect.objectContaining({
          text: expect.objectContaining({ content: "极高" }),
          value: expect.objectContaining({
            reasoningLevel: "xhigh"
          })
        })
      ])
    );
  });

  it("stores selected reasoning level in panel context", async () => {
    const service = new FeishuCommandPanelService({
      contextRepository,
      codexModelCatalogService: {
        listModels: vi.fn(() => ({
          defaultModel: "gpt-5.4",
          items: [
            {
              slug: "gpt-5.4",
              displayName: "GPT-5.4",
              description: "Model with multiple reasoning levels",
              defaultReasoningLevel: "medium",
              supportedReasoningLevels: [
                { effort: "low", description: "Fastest" },
                { effort: "medium", description: "Balanced" },
                { effort: "high", description: "Careful" }
              ],
              visibility: null,
              supportedInApi: true,
              priority: 10
            }
          ]
        }))
      } as never,
      codexAutoDispatchEnabled: false,
      codexCliBin: "codex"
    });

    const result = await service.selectModel("ou_test", "gpt-5.4", "high", true);
    const stored = contextRepository.findByOpenId("ou_test");

    expect(stored?.selectedModelSlug).toBe("gpt-5.4");
    expect(stored?.selectedModelName).toBe("GPT-5.4");
    expect(stored?.selectedReasoningLevel).toBe("high");
    const normalizedCard = normalizeCardText(result.card);
    expect(normalizedCard).toContain("默认推理：高");
    expect(normalizedCard).toContain("可选推理：低");
  });
});
