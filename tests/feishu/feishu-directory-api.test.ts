import { buildApp } from "../../src/app";
import { FeishuIdentityRepository } from "../../src/storage/repositories/feishu-identity-repository";
import { createSqliteDatabase, migrateDatabase } from "../../src/storage/sqlite";
import { createFetchMock } from "../helpers/fetch-mock";

function createFeishuOpenApiMock(options: { userNames?: Record<string, string | null | undefined> } = {}) {
  const messageBodies: string[] = [];
  const { fetchImpl } = createFetchMock([
    {
      match: /\/open-apis\/auth\/v3\/tenant_access_token\/internal$/,
      response: () =>
        new Response(
          JSON.stringify({
            code: 0,
            tenant_access_token: "token-demo",
            expire: 7200
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        )
    },
    {
      match: /\/open-apis\/contact\/v3\/users\/([^/?]+)\?user_id_type=open_id$/,
      response: ({ url }) => {
        const matched = url.match(/\/users\/([^/?]+)\?user_id_type=open_id$/);
        const openId = matched ? decodeURIComponent(matched[1]) : "";
        const displayName = options.userNames?.[openId] ?? null;

        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              user: displayName ? { name: displayName } : {}
            }
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }
    },
    {
      match: /\/open-apis\/im\/v1\/messages/,
      response: ({ bodyText }) => {
        messageBodies.push(bodyText);
        return new Response(JSON.stringify({ code: 0 }), {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        });
      }
    }
  ]);

  return {
    fetchImpl,
    messageBodies
  };
}

describe("feishu directory api", () => {
  it("returns recent open_id list from inbound feishu messages", async () => {
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);
    const identityRepository = new FeishuIdentityRepository(db);
    identityRepository.upsertManual({
      openId: "ou_user_1",
      displayName: "张三",
      boundBy: "web_console",
      updatedAt: new Date().toISOString()
    });

    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent"
      }
    });

    await app.inject({
      method: "POST",
      url: "/api/feishu/webhook",
      payload: {
        event: {
          type: "im.message.receive_v1",
          message: {
            message_id: "msg-openid-1",
            message_type: "text",
            content: "{\"text\":\"#session:feishu-openid-1 查询任务\"}"
          },
          sender: {
            sender_id: {
              open_id: "ou_user_1"
            }
          }
        }
      }
    });

    await app.inject({
      method: "POST",
      url: "/api/feishu/webhook",
      payload: {
        event: {
          type: "im.message.receive_v1",
          message: {
            message_id: "msg-openid-2",
            message_type: "text",
            content: "{\"text\":\"#session:feishu-openid-2 查询任务\"}"
          },
          sender: {
            sender_id: {
              open_id: "ou_user_2"
            }
          }
        }
      }
    });

    await app.inject({
      method: "POST",
      url: "/api/feishu/webhook",
      payload: {
        event: {
          type: "im.message.receive_v1",
          message: {
            message_id: "msg-openid-3",
            message_type: "text",
            content: "{\"text\":\"#session:feishu-openid-3 查询任务\"}"
          },
          sender: {
            sender_id: {
              open_id: "ou_user_1"
            }
          }
        }
      }
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/feishu/open-ids/recent?limit=10"
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      items: Array<{
        openId: string;
        messageCount: number;
        displayName: string | null;
        displayLabel: string;
      }>;
    };

    expect(payload.items).toHaveLength(2);
    expect(payload.items[0].openId).toBe("ou_user_1");
    expect(payload.items[0].messageCount).toBe(2);
    expect(payload.items[0].displayName).toBe("张三");
    expect(payload.items[0].displayLabel).toBe("张三 (ou_user_1)");
    expect(payload.items[1].openId).toBe("ou_user_2");
    expect(payload.items[1].displayName).toBeNull();
    expect(payload.items[1].displayLabel).toBe("ou_user_2");

    await app.close();
  });

  it("returns identity-only bindings even before a task message arrives", async () => {
    const mockOpenApi = createFeishuOpenApiMock({
      userNames: {
        ou_bind_only: "绑定专用"
      }
    });

    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);
    const app = buildApp({
      db,
      fetchImpl: mockOpenApi.fetchImpl,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuOpenBaseUrl: "http://mock.feishu"
      }
    });

    try {
      const currentConfigResponse = await app.inject({
        method: "GET",
        url: "/api/connectors/feishu/config"
      });
      const currentConfig = currentConfigResponse.json() as Record<string, unknown>;

      await app.inject({
        method: "PUT",
        url: "/api/connectors/feishu/config",
        payload: {
          ...currentConfig,
          enabled: true,
          appId: "app-id",
          appSecret: "app-secret",
          callbackUrl: ""
        }
      });

      const bindResponse = await app.inject({
        method: "POST",
        url: "/api/feishu/webhook",
        payload: {
          event: {
            type: "im.message.receive_v1",
            message: {
              message_id: "msg-bind-only",
              message_type: "text",
              content: "{\"text\":\"绑定姓名：绑定专用\"}"
            },
            sender: {
              sender_id: {
                open_id: "ou_bind_only"
              }
            }
          }
        }
      });

      expect(bindResponse.statusCode).toBe(200);
      expect(bindResponse.json()).toMatchObject({
        accepted: true,
        identity: {
          openId: "ou_bind_only",
          displayName: "绑定专用",
          bindingSource: "manual"
        }
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/feishu/open-ids/recent?limit=10"
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json() as {
        items: Array<{
          openId: string;
          messageCount: number;
          displayName: string | null;
          displayLabel: string;
          bindingSource: string | null;
        }>;
      };

      const item = payload.items.find((record) => record.openId === "ou_bind_only");
      expect(item).toMatchObject({
        openId: "ou_bind_only",
        messageCount: 0,
        displayName: "绑定专用",
        displayLabel: "绑定专用 (ou_bind_only)",
        bindingSource: "manual"
      });
    } finally {
      await app.close();
    }
  });

  it("sends message to specified open_id", async () => {
    const mockOpenApi = createFeishuOpenApiMock();

    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);
    const app = buildApp({
      db,
      fetchImpl: mockOpenApi.fetchImpl,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuOpenBaseUrl: "http://mock.feishu"
      }
    });

    try {
      const currentConfigResponse = await app.inject({
        method: "GET",
        url: "/api/connectors/feishu/config"
      });
      const currentConfig = currentConfigResponse.json() as Record<string, unknown>;

      await app.inject({
        method: "PUT",
        url: "/api/connectors/feishu/config",
        payload: {
          ...currentConfig,
          enabled: true,
          appId: "app-id",
          appSecret: "app-secret",
          callbackUrl: ""
        }
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/feishu/messages/send",
        payload: {
          openId: "ou_target_user",
          text: "hello from console",
          actorId: "web_admin"
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        success: true,
        openId: "ou_target_user",
        notify: {
          sent: true,
          statusCode: 200
        }
      });
      expect(mockOpenApi.messageBodies).toHaveLength(1);

      const sentPayload = JSON.parse(mockOpenApi.messageBodies[0]) as {
        receive_id: string;
        msg_type: string;
      };
      expect(sentPayload.receive_id).toBe("ou_target_user");
      expect(sentPayload.msg_type).toBe("text");
    } finally {
      await app.close();
    }
  });
});
