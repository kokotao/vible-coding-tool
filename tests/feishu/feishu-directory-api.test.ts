import { createServer } from "node:http";
import { buildApp } from "../../src/app";
import { createSqliteDatabase, migrateDatabase } from "../../src/storage/sqlite";

describe("feishu directory api", () => {
  it("returns recent open_id list from inbound feishu messages", async () => {
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

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
      }>;
    };

    expect(payload.items).toHaveLength(2);
    expect(payload.items[0].openId).toBe("ou_user_1");
    expect(payload.items[0].messageCount).toBe(2);
    expect(payload.items[1].openId).toBe("ou_user_2");

    await app.close();
  });

  it("sends message to specified open_id", async () => {
    const messageBodies: string[] = [];
    const mockOpenApiServer = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => {
        raw += String(chunk);
      });
      request.on("end", () => {
        if (request.url === "/open-apis/auth/v3/tenant_access_token/internal") {
          response.statusCode = 200;
          response.setHeader("content-type", "application/json");
          response.end("{\"code\":0,\"tenant_access_token\":\"token-demo\",\"expire\":7200}");
          return;
        }

        if (request.url?.startsWith("/open-apis/im/v1/messages")) {
          messageBodies.push(raw);
          response.statusCode = 200;
          response.setHeader("content-type", "application/json");
          response.end("{\"code\":0}");
          return;
        }

        response.statusCode = 404;
        response.end();
      });
    });

    await new Promise<void>((resolve) => {
      mockOpenApiServer.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = mockOpenApiServer.address();
      if (!address || typeof address === "string") {
        throw new Error("Mock open api server address is invalid");
      }

      const db = createSqliteDatabase(":memory:");
      migrateDatabase(db);
      const app = buildApp({
        db,
        env: {
          databasePath: ":memory:",
          logLevel: "silent",
          feishuOpenBaseUrl: `http://127.0.0.1:${address.port}`
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
        expect(messageBodies).toHaveLength(1);

        const sentPayload = JSON.parse(messageBodies[0]) as {
          receive_id: string;
          msg_type: string;
        };
        expect(sentPayload.receive_id).toBe("ou_target_user");
        expect(sentPayload.msg_type).toBe("text");
      } finally {
        await app.close();
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        mockOpenApiServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });
});
