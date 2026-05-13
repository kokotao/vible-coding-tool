import { resolveFeishuWsBridgeDefaults, startFeishuWsBridge } from "../../src/modules/feishu/feishu-ws-bridge";
import { createFetchMock } from "../helpers/fetch-mock";
import { createAdminHeaders } from "../helpers/admin-auth";

describe("feishu websocket bridge", () => {
  it("auto resolves credentials from gateway and forwards incoming events", async () => {
    const forwardedBodies: string[] = [];
    const { fetchImpl } = createFetchMock([
      {
        match: /\/health$/,
        response: () => new Response(JSON.stringify({ ok: true }), { status: 200 })
      },
      {
        match: /\/api\/connectors\/feishu\/runtime-config$/,
        response: () =>
          new Response(JSON.stringify({ appId: "cli-demo", appSecret: "secret-demo" }), {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          })
      },
      {
        match: /\/api\/feishu\/webhook$/,
        response: ({ bodyText }) => {
          forwardedBodies.push(bodyText);
          return new Response(JSON.stringify({ accepted: true }), {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          });
        }
      }
    ]);

    const messages: Array<Record<string, unknown>> = [];
    const handle = await startFeishuWsBridge({
      gatewayUrl: "http://mock.gateway",
      verifyToken: "verify-token",
      fetchImpl,
      gatewayHeaders: createAdminHeaders(),
      clientFactory: () => ({
        start: async ({ eventDispatcher }) => {
          const handlers = eventDispatcher as {
            "im.message.receive_v1": (event: Record<string, unknown>) => Promise<void>;
            "card.action.trigger": (event: Record<string, unknown>) => Promise<void>;
          };
          const event = {
            message: {
              message_id: "msg-001",
              message_type: "text",
              content: "{\"text\":\"#session:test-session 你好\"}"
            },
            sender: {
              sender_id: {
                open_id: "ou_test"
              }
            }
          };
          messages.push(event);
          await handlers["im.message.receive_v1"](event);

          const actionEvent = {
            context: {
              open_message_id: "msg-002",
              open_chat_id: "chat-001"
            },
            operator: {
              open_id: "ou_test"
            },
            action: {
              tag: "button",
              value: {
                panelAction: "view_projects"
              }
            }
          };
          messages.push(actionEvent);
          await handlers["card.action.trigger"](actionEvent);
        },
        close: () => {
          messages.push({ closed: true });
        }
      }),
      dispatcherFactory: (handlers) => handlers
    });

    try {
      expect(forwardedBodies).toHaveLength(2);
      expect(forwardedBodies[0]).toContain("test-session");
      expect(forwardedBodies[0]).toContain("ou_test");
      expect(forwardedBodies[1]).toContain("card.action.trigger");
      expect(messages).toHaveLength(2);
    } finally {
      await handle.stop();
    }
  });

  it("defaults to auto start outside test env", () => {
    expect(resolveFeishuWsBridgeDefaults().autoStart).toBe(false);
  });

  it("throws when runtime config is missing secret", async () => {
    const { fetchImpl } = createFetchMock([
      {
        match: /\/api\/connectors\/feishu\/runtime-config$/,
        response: () =>
          new Response(JSON.stringify({ appId: "cli-demo", appSecretConfigured: true, appSecretMasked: "sec***mo" }), {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          })
      }
    ]);

    await expect(
      startFeishuWsBridge({
        gatewayUrl: "http://mock.gateway",
        fetchImpl,
        gatewayHeaders: createAdminHeaders()
      })
    ).rejects.toThrow("missing FEISHU_APP_ID/FEISHU_APP_SECRET");
  });
});
