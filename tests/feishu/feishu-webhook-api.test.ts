import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { buildApp } from "../../src/app";
import { createSqliteDatabase, migrateDatabase } from "../../src/storage/sqlite";

function buildFeishuSignature(payload: unknown, timestamp: string, nonce: string, encryptKey: string) {
  return createHash("sha256")
    .update(timestamp + nonce + encryptKey + JSON.stringify(payload))
    .digest("hex");
}

describe("feishu webhook api", () => {
  it("returns challenge response", async () => {
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuVerifyToken: "verify-token"
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/feishu/webhook",
      headers: {
        "x-lark-request-token": "verify-token"
      },
      payload: {
        challenge: "challenge-abc"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      challenge: "challenge-abc"
    });

    await app.close();
  });

  it("accepts low risk command and creates running task", async () => {
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuVerifyToken: "verify-token"
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/feishu/webhook",
      headers: {
        "x-lark-request-token": "verify-token"
      },
      payload: {
        event: {
          type: "im.message.receive_v1",
          message: {
            message_id: "msg-001",
            message_type: "text",
            content: "{\"text\":\"#session:feishu-codex-001 修复登录接口 500\"}"
          },
          sender: {
            sender_id: {
              open_id: "ou_alice"
            }
          }
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        accepted: true,
        sessionId: "feishu-codex-001",
        riskLevel: "low",
        pendingConfirmation: false
      })
    );

    const dashboard = await app.inject({
      method: "GET",
      url: "/api/dashboard/summary"
    });

    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().summary.runningTaskCount).toBe(1);
    expect(dashboard.json().summary.activeSessionCount).toBe(1);

    await app.close();
  });

  it("pushes outbound status to feishu open api when connector is enabled", async () => {
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
      const openBaseUrl = `http://127.0.0.1:${address.port}`;

      const app = buildApp({
        db,
        env: {
          databasePath: ":memory:",
          logLevel: "silent",
          feishuVerifyToken: "verify-token",
          feishuOpenBaseUrl: openBaseUrl
        }
      });

      try {
        const current = await app.inject({
          method: "GET",
          url: "/api/connectors/feishu/config"
        });
        const currentConfig = current.json() as Record<string, unknown>;

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
          url: "/api/feishu/webhook",
          headers: {
            "x-lark-request-token": "verify-token"
          },
          payload: {
            event: {
              type: "im.message.receive_v1",
              message: {
                message_id: "msg-out-001",
                message_type: "text",
                content: "{\"text\":\"#session:feishu-codex-outbound 查询状态\"}"
              },
              sender: {
                sender_id: {
                  open_id: "ou_outbound"
                }
              }
            }
          }
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().notify).toMatchObject({
          sent: true,
          skipped: false,
          statusCode: 200
        });
        expect(messageBodies).toHaveLength(1);

        const payload = JSON.parse(messageBodies[0]) as {
          receive_id: string;
          msg_type: string;
          content: string;
        };
        expect(payload.receive_id).toBe("ou_outbound");
        expect(payload.msg_type).toBe("text");
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

  it("accepts schema 2.0 event payload", async () => {
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuVerifyToken: "verify-token"
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/feishu/webhook",
      payload: {
        schema: "2.0",
        header: {
          event_id: "evt-schema-1",
          event_type: "im.message.receive_v1",
          token: "verify-token"
        },
        event: {
          message: {
            message_id: "msg-schema-1",
            message_type: "text",
            content: "{\"text\":\"#session:feishu-codex-003 查询当前进度\"}"
          },
          sender: {
            sender_id: {
              open_id: "ou_schema"
            }
          }
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        accepted: true,
        sessionId: "feishu-codex-003",
        pendingConfirmation: false
      })
    );

    await app.close();
  });

  it("creates pending confirmation for high risk command", async () => {
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuVerifyToken: "verify-token"
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/feishu/webhook",
      headers: {
        "x-lark-request-token": "verify-token"
      },
      payload: {
        event: {
          type: "im.message.receive_v1",
          message: {
            message_id: "msg-002",
            message_type: "text",
            content: "{\"text\":\"#session:feishu-codex-002 删除线上配置并强制推送\"}"
          },
          sender: {
            sender_id: {
              open_id: "ou_bob"
            }
          }
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        accepted: true,
        riskLevel: "high",
        pendingConfirmation: true
      })
    );

    const dashboard = await app.inject({
      method: "GET",
      url: "/api/dashboard/summary"
    });

    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().summary.pendingRiskCount).toBe(1);

    await app.close();
  });

  it("routes by 线程 ID + 任务内容 and reuses sender latest session when #session omitted", async () => {
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuVerifyToken: "verify-token"
      }
    });

    const bindSessionResponse = await app.inject({
      method: "POST",
      url: "/api/feishu/webhook",
      headers: {
        "x-lark-request-token": "verify-token"
      },
      payload: {
        event: {
          type: "im.message.receive_v1",
          message: {
            message_id: "msg-bind-session",
            message_type: "text",
            content: "{\"text\":\"#session:feishu-codex-demo 先绑定会话\"}"
          },
          sender: {
            sender_id: {
              open_id: "ou_thread_user"
            }
          }
        }
      }
    });
    expect(bindSessionResponse.statusCode).toBe(200);

    const threadRef = "019dca61-0d90-7f01-b1b0-f1bb79eb955e";
    const syncThreadResponse = await app.inject({
      method: "POST",
      url: "/api/codex/events",
      payload: {
        eventId: "evt-thread-bind-1",
        sessionId: "feishu-codex-demo",
        taskId: "task-thread-bind-1",
        toolSessionRef: threadRef,
        status: "running",
        summary: "Codex任务完成：线程初始化"
      }
    });
    expect(syncThreadResponse.statusCode).toBe(200);

    const response = await app.inject({
      method: "POST",
      url: "/api/feishu/webhook",
      headers: {
        "x-lark-request-token": "verify-token"
      },
      payload: {
        event: {
          type: "im.message.receive_v1",
          message: {
            message_id: "msg-thread-route",
            message_type: "text",
            content:
              "{\"text\":\"线程 ID：019dca61-线程初始化 (019dca61-0d90-7f01-b1b0-f1bb79eb955e)，任务内容：完成我所说的需求进行下一步\"}"
          },
          sender: {
            sender_id: {
              open_id: "ou_thread_user"
            }
          }
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        accepted: true,
        sessionId: "feishu-codex-demo",
        threadRef,
        dispatch: expect.objectContaining({
          skipped: true,
          reason: "dispatch_disabled"
        })
      })
    );

    await app.close();
  });

  it("rejects request when verify token mismatch", async () => {
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuVerifyToken: "verify-token"
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/feishu/webhook",
      headers: {
        "x-lark-request-token": "bad-token"
      },
      payload: {
        challenge: "challenge-abc"
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      code: "FEISHU_VERIFY_FAILED",
      message: "Feishu verify token mismatch"
    });

    await app.close();
  });

  it("rejects request when signature is invalid", async () => {
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuEncryptKey: "encrypt-key-demo"
      }
    });

    const payload = {
      event: {
        type: "im.message.receive_v1",
        message: {
          message_id: "msg-sign-1",
          message_type: "text",
          content: "{\"text\":\"#session:feishu-codex-sign 查询状态\"}"
        },
        sender: {
          sender_id: {
            open_id: "ou_sign"
          }
        }
      }
    };

    const response = await app.inject({
      method: "POST",
      url: "/api/feishu/webhook",
      headers: {
        "x-lark-request-timestamp": "1714095000",
        "x-lark-request-nonce": "nonce-demo",
        "x-lark-signature": "bad-signature"
      },
      payload
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      code: "FEISHU_SIGNATURE_INVALID",
      message: "Feishu signature verification failed"
    });

    await app.close();
  });

  it("accepts request with valid signature when encrypt key configured", async () => {
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuEncryptKey: "encrypt-key-demo"
      }
    });

    const payload = {
      event: {
        type: "im.message.receive_v1",
        message: {
          message_id: "msg-sign-2",
          message_type: "text",
          content: "{\"text\":\"#session:feishu-codex-sign-ok 查询状态\"}"
        },
        sender: {
          sender_id: {
            open_id: "ou_sign_ok"
          }
        }
      }
    };

    const timestamp = "1714095001";
    const nonce = "nonce-demo-ok";
    const signature = buildFeishuSignature(payload, timestamp, nonce, "encrypt-key-demo");

    const response = await app.inject({
      method: "POST",
      url: "/api/feishu/webhook",
      headers: {
        "x-lark-request-timestamp": timestamp,
        "x-lark-request-nonce": nonce,
        "x-lark-signature": signature
      },
      payload
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        accepted: true,
        pendingConfirmation: false
      })
    );

    await app.close();
  });

  it("ignores duplicate message event", async () => {
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuVerifyToken: "verify-token"
      }
    });

    const payload = {
      event: {
        type: "im.message.receive_v1",
        message: {
          message_id: "msg-dup-1",
          message_type: "text",
          content: "{\"text\":\"#session:feishu-codex-dup 修复重复事件\"}"
        },
        sender: {
          sender_id: {
            open_id: "ou_dup"
          }
        }
      }
    };

    const first = await app.inject({
      method: "POST",
      url: "/api/feishu/webhook",
      headers: {
        "x-lark-request-token": "verify-token"
      },
      payload
    });

    const second = await app.inject({
      method: "POST",
      url: "/api/feishu/webhook",
      headers: {
        "x-lark-request-token": "verify-token"
      },
      payload
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(
      expect.objectContaining({
        accepted: true,
        duplicate: true,
        message: "Duplicate event ignored"
      })
    );

    const dashboard = await app.inject({
      method: "GET",
      url: "/api/dashboard/summary"
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().summary.runningTaskCount).toBe(1);

    await app.close();
  });
});
