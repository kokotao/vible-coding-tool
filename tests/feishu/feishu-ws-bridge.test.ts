import { resolveFeishuWsBridgeDefaults, startFeishuWsBridge } from "../../src/modules/feishu/feishu-ws-bridge";
import { createFetchMock } from "../helpers/fetch-mock";

describe("feishu websocket bridge", () => {
  it("auto resolves credentials from gateway and forwards incoming events", async () => {
    const forwardedBodies: string[] = [];
    const { fetchImpl } = createFetchMock([
      {
        match: /\/health$/,
        response: () => new Response(JSON.stringify({ ok: true }), { status: 200 })
      },
      {
        match: /\/api\/connectors\/feishu\/config$/,
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
      clientFactory: () => ({
        start: async ({ eventDispatcher }) => {
          const handlers = eventDispatcher as {
            "im.message.receive_v1": (event: Record<string, unknown>) => Promise<void>;
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
        },
        close: () => {
          messages.push({ closed: true });
        }
      }),
      dispatcherFactory: (handlers) => handlers
    });

    try {
      expect(forwardedBodies).toHaveLength(1);
      expect(forwardedBodies[0]).toContain("test-session");
      expect(forwardedBodies[0]).toContain("ou_test");
      expect(messages).toHaveLength(1);
    } finally {
      await handle.stop();
    }
  });

  it("defaults to auto start outside test env", () => {
    expect(resolveFeishuWsBridgeDefaults().autoStart).toBe(false);
  });
});
