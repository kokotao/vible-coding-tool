import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../../src/app";
import { createSqliteDatabase, migrateDatabase } from "../../src/storage/sqlite";
import { createFetchMock } from "../helpers/fetch-mock";

function buildFeishuSignature(payload: unknown, timestamp: string, nonce: string, encryptKey: string) {
  return createHash("sha256")
    .update(timestamp + nonce + encryptKey + JSON.stringify(payload))
    .digest("hex");
}

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

function parseOutboundInteractiveCard(bodyText: string) {
  const payload = JSON.parse(bodyText) as {
    msg_type: string;
    content: string;
  };

  expect(payload.msg_type).toBe("interactive");
  return JSON.parse(payload.content) as {
    header?: {
      template?: string;
      title?: {
        content?: string;
      };
    };
    elements: Array<{
      tag: string;
      content?: string;
      actions?: Array<{
        tag: string;
        type?: string;
        text?: {
          content?: string;
        };
        value?: Record<string, unknown>;
      }>;
    }>;
  };
}

function createFeishuPanelSessionsFixture() {
  const sessionsRoot = mkdtempSync(join(tmpdir(), "feishu-panel-sessions-"));
  const dayPath = join(sessionsRoot, "2026", "04", "27");
  mkdirSync(dayPath, { recursive: true });

  const projectAlphaPath = "/Users/albertluo/workSpace/albertLuo/project-alpha";
  const projectBetaPath = "/Users/albertluo/workSpace/albertLuo/project-beta";
  const threadAlpha1 = "019dcd00-1111-7a22-8b33-aaaaaaaaaaaa";
  const threadAlpha2 = "019dcd00-2222-7a22-8b33-bbbbbbbbbbbb";
  const threadBeta1 = "019dcd00-3333-7a22-8b33-cccccccccccc";

  writeFileSync(
    join(dayPath, `rollout-2026-04-27T08-00-00-${threadAlpha1}.jsonl`),
    [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: threadAlpha1,
          timestamp: "2026-04-27T08:00:00.000Z",
          cwd: projectAlphaPath
        }
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: "瀹屽杽椋炰功椤圭洰鍗＄墖"
        }
      }),
      ""
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    join(dayPath, `rollout-2026-04-27T08-10-00-${threadAlpha2}.jsonl`),
    [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: threadAlpha2,
          timestamp: "2026-04-27T08:10:00.000Z",
          cwd: projectAlphaPath
        }
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: "鎶?session 鍒楄〃鍋氭垚杩炵画閫夋嫨"
        }
      }),
      ""
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    join(dayPath, `rollout-2026-04-27T08-20-00-${threadBeta1}.jsonl`),
    [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: threadBeta1,
          timestamp: "2026-04-27T08:20:00.000Z",
          cwd: projectBetaPath
        }
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: "修复网关状态展示"
        }
      }),
      ""
    ].join("\n"),
    "utf8"
  );

  return {
    sessionsRoot,
    projectAlphaPath,
    projectBetaPath,
    threadAlpha1,
    threadAlpha2,
    threadBeta1
  };
}

function createFeishuPanelPaginationFixture() {
  const sessionsRoot = mkdtempSync(join(tmpdir(), "feishu-panel-pagination-"));
  const dayPath = join(sessionsRoot, "2026", "04", "27");
  mkdirSync(dayPath, { recursive: true });

  const projectPath = "/Users/albertluo/workSpace/albertLuo/project-pagination";
  const now = Date.now();

  for (let index = 0; index < 10; index += 1) {
    const offsetMs = index < 9 ? index * 30 * 60 * 1000 : 3 * 24 * 60 * 60 * 1000;
    const timestamp = new Date(now - offsetMs).toISOString();
    const threadId = `019dce00-${(1000 + index).toString(16).padStart(4, "0")}-7a22-8b33-${(index + 1)
      .toString(16)
      .padStart(12, "0")}`;
    const rolloutFileName = `rollout-${timestamp.replace(/[:.]/g, "-")}-${threadId}.jsonl`;

    writeFileSync(
      join(dayPath, rolloutFileName),
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: threadId,
            timestamp,
            cwd: projectPath
          }
        }),
        JSON.stringify({
          type: "response_item",
          timestamp,
          payload: {
            type: "message",
            role: "user",
            content: `鍒嗛〉娴嬭瘯浼氳瘽 ${index + 1}`
          }
        }),
        ""
      ].join("\n"),
      "utf8"
    );
  }

  return {
    sessionsRoot,
    projectPath
  };
}

function createFeishuProjectPathScanFixture() {
  const sessionsRoot = mkdtempSync(join(tmpdir(), "feishu-panel-path-scan-"));
  const projectRoot = join(sessionsRoot, "workspace-projects");
  const projectAPath = join(projectRoot, "demo-project-a");
  const projectBPath = join(projectRoot, "demo-project-b");
  mkdirSync(projectAPath, { recursive: true });
  mkdirSync(projectBPath, { recursive: true });
  mkdirSync(join(projectRoot, ".hidden-project"), { recursive: true });

  return {
    sessionsRoot,
    projectRoot,
    projectAPath,
    projectBPath
  };
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

  it("returns challenge response before signature validation when encrypt key is configured", async () => {
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

    const response = await app.inject({
      method: "POST",
      url: "/api/feishu/webhook",
      payload: {
        challenge: "challenge-plain-abc",
        type: "url_verification"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      challenge: "challenge-plain-abc"
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
            content: "{\"text\":\"#session:feishu-codex-001 淇鐧诲綍鎺ュ彛 500\"}"
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

  it("auto-resolves sender identity on first inbound message and stores display label", async () => {
    const mockOpenApi = createFeishuOpenApiMock({
      userNames: {
        ou_auto_user: "鑷姩璇嗗埆濮撳悕"
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
        feishuVerifyToken: "verify-token",
        feishuOpenBaseUrl: "http://mock.feishu"
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
              message_id: "msg-auto-name",
              message_type: "text",
              content: "{\"text\":\"#session:feishu-auto-name 缁х画鎵ц\"}"
            },
            sender: {
              sender_id: {
                open_id: "ou_auto_user"
              }
            }
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.objectContaining({
          accepted: true,
          senderIdentity: {
            openId: "ou_auto_user",
            displayName: "鑷姩璇嗗埆濮撳悕",
            bindingSource: "auto",
            boundBy: null
          }
        })
      );

      const recent = await app.inject({
        method: "GET",
        url: "/api/feishu/open-ids/recent?limit=10"
      });
      const payload = recent.json() as {
        items: Array<{
          openId: string;
          displayName: string | null;
          displayLabel: string;
          bindingSource: string | null;
        }>;
      };
      const item = payload.items.find((record) => record.openId === "ou_auto_user");

      expect(item).toMatchObject({
        openId: "ou_auto_user",
        displayName: "鑷姩璇嗗埆濮撳悕",
        displayLabel: "鑷姩璇嗗埆濮撳悕 (ou_auto_user)",
        bindingSource: "auto"
      });

      expect(mockOpenApi.messageBodies).toHaveLength(1);
      const cardPayload = parseOutboundInteractiveCard(mockOpenApi.messageBodies[0]);
      const metadataBlock = cardPayload.elements.find((item) => item.tag === "markdown" && item.content?.includes("任务标题"));
      expect(metadataBlock?.content).toContain("浼氳瘽ID锛歠eishu-auto-name");
      expect(metadataBlock?.content).toContain("瑙﹀彂鏂癸細鑷姩璇嗗埆濮撳悕");
      expect(metadataBlock?.content).toContain("绾跨▼ID锛氭棤");
    } finally {
      await app.close();
    }
  });

  it("manual binding overrides auto identity resolution", async () => {
    const mockOpenApi = createFeishuOpenApiMock({
      userNames: {
        ou_override_user: "鑷姩濮撳悕"
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
        feishuVerifyToken: "verify-token",
        feishuOpenBaseUrl: "http://mock.feishu"
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

      const autoResponse = await app.inject({
        method: "POST",
        url: "/api/feishu/webhook",
        headers: {
          "x-lark-request-token": "verify-token"
        },
        payload: {
          event: {
            type: "im.message.receive_v1",
            message: {
              message_id: "msg-override-auto",
              message_type: "text",
              content: "{\"text\":\"#session:feishu-override-auto 自动识别一条\"}"
            },
            sender: {
              sender_id: {
                open_id: "ou_override_user"
              }
            }
          }
        }
      });
      expect(autoResponse.statusCode).toBe(200);
      expect(autoResponse.json()).toEqual(
        expect.objectContaining({
          senderIdentity: expect.objectContaining({
            displayName: "鑷姩濮撳悕",
            bindingSource: "auto"
          })
        })
      );

      const bindResponse = await app.inject({
        method: "POST",
        url: "/api/feishu/webhook",
        headers: {
          "x-lark-request-token": "verify-token"
        },
        payload: {
          event: {
            type: "im.message.receive_v1",
            message: {
              message_id: "msg-override-manual",
              message_type: "text",
              content: "{\"text\":\"绑定姓名：手动覆盖\"}"
            },
            sender: {
              sender_id: {
                open_id: "ou_override_user"
              }
            }
          }
        }
      });

      expect(bindResponse.statusCode).toBe(200);
      expect(bindResponse.json()).toEqual(
        expect.objectContaining({
          accepted: true,
          message: "宸茬粦瀹氬鍚嶏細鎵嬪姩瑕嗙洊",
          identity: {
            openId: "ou_override_user",
            displayName: "鎵嬪姩瑕嗙洊",
            bindingSource: "manual",
            boundBy: "ou_override_user"
          }
        })
      );

      const recent = await app.inject({
        method: "GET",
        url: "/api/feishu/open-ids/recent?limit=10"
      });
      const payload = recent.json() as {
        items: Array<{
          openId: string;
          displayName: string | null;
          displayLabel: string;
          bindingSource: string | null;
        }>;
      };
      const item = payload.items.find((record) => record.openId === "ou_override_user");

      expect(item).toMatchObject({
        openId: "ou_override_user",
        displayName: "鎵嬪姩瑕嗙洊",
        displayLabel: "鎵嬪姩瑕嗙洊 (ou_override_user)",
        bindingSource: "manual"
      });
    } finally {
      await app.close();
    }
  });

  it("binds an explicit target open_id even when the message contains a mention prefix", async () => {
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

    try {
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
              message_id: "msg-bind-target",
              message_type: "text",
              content: "{\"text\":\"@鏈哄櫒浜?缁戝畾濮撳悕:TauChun 瑙﹀彂鏂?ou_target_bind\"}"
            },
            sender: {
              sender_id: {
                open_id: "ou_admin_sender"
              }
            }
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        accepted: true,
        identity: {
          openId: "ou_target_bind",
          displayName: "TauChun",
          bindingSource: "manual",
          boundBy: "ou_admin_sender"
        },
        targetOpenId: "ou_target_bind"
      });

      const recent = await app.inject({
        method: "GET",
        url: "/api/feishu/open-ids/recent?limit=10"
      });
      const payload = recent.json() as {
        items: Array<{
          openId: string;
          displayName: string | null;
          displayLabel: string;
          bindingSource: string | null;
        }>;
      };
      const item = payload.items.find((record) => record.openId === "ou_target_bind");

      expect(item).toMatchObject({
        openId: "ou_target_bind",
        displayName: "TauChun",
        displayLabel: "TauChun (ou_target_bind)",
        bindingSource: "manual"
      });
    } finally {
      await app.close();
    }
  });

  it("falls back to open_id when Feishu user profile name is unavailable", async () => {
    const mockOpenApi = createFeishuOpenApiMock();
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      fetchImpl: mockOpenApi.fetchImpl,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuVerifyToken: "verify-token",
        feishuOpenBaseUrl: "http://mock.feishu"
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
              message_id: "msg-fallback-name",
              message_type: "text",
              content: "{\"text\":\"#session:feishu-fallback-name 缁х画鎵ц\"}"
            },
            sender: {
              sender_id: {
                open_id: "ou_fallback_user"
              }
            }
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.objectContaining({
          senderIdentity: null
        })
      );

      const recent = await app.inject({
        method: "GET",
        url: "/api/feishu/open-ids/recent?limit=10"
      });
      const payload = recent.json() as {
        items: Array<{
          openId: string;
          displayName: string | null;
          displayLabel: string;
          bindingSource: string | null;
        }>;
      };
      const item = payload.items.find((record) => record.openId === "ou_fallback_user");

      expect(item).toMatchObject({
        openId: "ou_fallback_user",
        displayName: null,
        displayLabel: "ou_fallback_user",
        bindingSource: null
      });

      expect(mockOpenApi.messageBodies).toHaveLength(1);
      const cardPayload = parseOutboundInteractiveCard(mockOpenApi.messageBodies[0]);
      const metadataBlock = cardPayload.elements.find((item) => item.tag === "markdown" && item.content?.includes("任务标题"));
      expect(metadataBlock?.content).toContain("瑙﹀彂鏂癸細ou_fallback_user");
    } finally {
      await app.close();
    }
  });

  it("pushes outbound status to feishu open api when connector is enabled", async () => {
    const mockOpenApi = createFeishuOpenApiMock();
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);
    const openBaseUrl = "http://mock.feishu";

    const app = buildApp({
      db,
      fetchImpl: mockOpenApi.fetchImpl,
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
      expect(mockOpenApi.messageBodies).toHaveLength(1);

      const payload = JSON.parse(mockOpenApi.messageBodies[0]) as {
        receive_id: string;
        msg_type: string;
        content: string;
      };
      expect(payload.receive_id).toBe("ou_outbound");
      expect(payload.msg_type).toBe("interactive");
      expect(payload.content).toContain("浠诲姟鏍囬");
      expect(payload.content).toContain("浠诲姟鍐呭");

      const taskDetail = await app.inject({
        method: "GET",
        url: `/api/tasks/${encodeURIComponent(response.json().taskId as string)}/detail`
      });
      expect(taskDetail.statusCode).toBe(200);
      expect(
        (taskDetail.json() as { auditLogs: Array<{ action: string; result: string }> }).auditLogs.some(
          (item) => item.action === "feishu_notify_status" && item.result === "success"
        )
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("records notify failure in task audit logs when feishu open api is unreachable", async () => {
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuVerifyToken: "verify-token",
        feishuOpenBaseUrl: "http://127.0.0.1:65535"
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
              message_id: "msg-failed-notify",
              message_type: "text",
              content: "{\"text\":\"#session:feishu-codex-notify-fail 继续下一步\"}"
            },
            sender: {
              sender_id: {
                open_id: "ou_notify_fail"
              }
            }
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.objectContaining({
          accepted: true,
          notify: expect.objectContaining({
            sent: false,
            skipped: false,
            reason: "auth_failed"
          })
        })
      );

      const taskId = (response.json() as { taskId: string }).taskId;
      const taskDetail = await app.inject({
        method: "GET",
        url: `/api/tasks/${encodeURIComponent(taskId)}/detail`
      });

      expect(taskDetail.statusCode).toBe(200);
      expect(
        (taskDetail.json() as { auditLogs: Array<{ action: string; result: string }> }).auditLogs.some(
          (item) => item.action === "feishu_notify_status" && item.result === "failed"
        )
      ).toBe(true);
    } finally {
      await app.close();
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
            content: "{\"text\":\"#session:feishu-codex-003 鏌ヨ褰撳墠杩涘害\"}"
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

  it("blocks ambiguous commands and replies with command guidance", async () => {
    const mockOpenApi = createFeishuOpenApiMock();
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      fetchImpl: mockOpenApi.fetchImpl,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuVerifyToken: "verify-token",
        feishuOpenBaseUrl: "http://mock.feishu"
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
              message_id: "msg-ambiguous-001",
              message_type: "text",
              content: "{\"text\":\"甯垜淇鐧诲綍鎺ュ彛\"}"
            },
            sender: {
              sender_id: {
                open_id: "ou_ambiguous_user"
              }
            }
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.objectContaining({
          accepted: false,
          skipped: true,
          reason: "ambiguous_command",
          message: expect.any(String),
          help: expect.objectContaining({
            title: "椋炰功鎸囦护閫熸煡",
            commands: expect.any(Array)
          })
        })
      );

      expect(mockOpenApi.messageBodies).toHaveLength(1);
      const outbound = JSON.parse(mockOpenApi.messageBodies[0]) as {
        receive_id: string;
        msg_type: string;
        content: string;
      };
      const outboundContent = JSON.parse(outbound.content) as {
        config: { wide_screen_mode?: boolean };
        header: { template?: string; title: { content: string } };
        elements: Array<{ tag: string; content?: string; elements?: Array<{ content?: string }> }>;
      };

      expect(outbound.receive_id).toBe("ou_ambiguous_user");
      expect(outbound.msg_type).toBe("interactive");
      expect(outboundContent.config.wide_screen_mode).toBe(true);
      expect(outboundContent.header.title.content.length).toBeGreaterThan(0);
      expect(outboundContent.header.template).toBe("blue");
      expect(outboundContent.elements[0].content).toContain("鎷︽埅缁撴灉");
      expect(outboundContent.elements[2].content).toContain("#session:<id>");
      expect(outboundContent.elements[2].content).toContain("#session:<id>");
      expect(outboundContent.elements[2].content).toContain("线程 ID");
      expect(outboundContent.elements[2].content).toContain("绑定姓名");
      expect(outboundContent.elements[3].elements?.[0].content).toContain("缁х画宸叉湁浼氳瘽");

      const dashboard = await app.inject({
        method: "GET",
        url: "/api/dashboard/summary"
      });

      expect(dashboard.statusCode).toBe(200);
      expect(dashboard.json().summary.runningTaskCount).toBe(0);
      expect(dashboard.json().summary.pendingRiskCount).toBe(0);
      expect(dashboard.json().summary.activeSessionCount).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("routes by 绾跨▼ ID + 浠诲姟鍐呭 and reuses sender latest session when #session omitted", async () => {
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
        summary: "Codex浠诲姟瀹屾垚锛氱嚎绋嬪垵濮嬪寲"
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
              "{\"text\":\"线程 ID：19dca61-线程初始化(019dca61-0d90-7f01-b1b0-f1bb79eb955e)，任务内容：完成我所说的需求进行下一步\"}"
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

  it("routes by local rollout short thread prefix when DB thread mapping is absent", async () => {
    const sessionsRoot = mkdtempSync(join(tmpdir(), "feishu-thread-prefix-"));
    const dayPath = join(sessionsRoot, "2026", "04", "26");
    mkdirSync(dayPath, { recursive: true });
    const threadRef = "019dca59-78b8-7d10-88fd-b6f9b8a7c409";
    writeFileSync(join(dayPath, `rollout-2026-04-26T23-12-34-${threadRef}.jsonl`), "{\"type\":\"turn_context\"}\n", "utf8");

    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuVerifyToken: "verify-token",
        codexLocalSessionsScanEnabled: true,
        codexLocalSessionsRoot: sessionsRoot,
        codexLocalSessionsScanIntervalMs: 1000
      }
    });

    try {
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
              message_id: "msg-bind-local-prefix",
              message_type: "text",
              content: "{\"text\":\"#session:feishu-codex-demo-prefix 先绑定会话\"}"
            },
            sender: {
              sender_id: {
                open_id: "ou_thread_prefix_user"
              }
            }
          }
        }
      });
      expect(bindSessionResponse.statusCode).toBe(200);

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
              message_id: "msg-thread-prefix-route",
              message_type: "text",
              content: "{\"text\":\"线程 ID：19dca59-发布线程，任务内容：继续下一步\"}"
            },
            sender: {
              sender_id: {
                open_id: "ou_thread_prefix_user"
              }
            }
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.objectContaining({
          accepted: true,
          sessionId: "feishu-codex-demo-prefix",
          threadRef,
          dispatch: expect.objectContaining({
            skipped: true,
            reason: "dispatch_disabled"
          })
        })
      );
    } finally {
      await app.close();
      rmSync(sessionsRoot, { recursive: true, force: true });
    }
  });

  it("returns project list card for panel command 鏌ョ湅椤圭洰", async () => {
    const fixture = createFeishuPanelSessionsFixture();
    const mockOpenApi = createFeishuOpenApiMock();
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      fetchImpl: mockOpenApi.fetchImpl,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuVerifyToken: "verify-token",
        feishuOpenBaseUrl: "http://mock.feishu",
        codexLocalSessionsScanEnabled: true,
        codexLocalSessionsRoot: fixture.sessionsRoot,
        codexLocalSessionsScanIntervalMs: 1000
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
              message_id: "msg-panel-view-projects",
              message_type: "text",
              content: "{\"text\":\"鏌ョ湅椤圭洰\"}"
            },
            sender: {
              sender_id: {
                open_id: "ou_panel_card_user"
              }
            }
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.objectContaining({
          accepted: true,
          command: "view_projects",
          context: expect.objectContaining({
            currentView: "project_list"
          })
        })
      );

      expect(mockOpenApi.messageBodies).toHaveLength(1);
      const outbound = JSON.parse(mockOpenApi.messageBodies[0]) as {
        receive_id: string;
        msg_type: string;
        content: string;
      };
      const card = JSON.parse(outbound.content) as {
        header: { title: { content: string } };
        elements: Array<{ content?: string }>;
      };
      expect(outbound.receive_id).toBe("ou_panel_card_user");
      expect(outbound.msg_type).toBe("interactive");
      expect(card.header.title.content).toBe("椤圭洰鍒楄〃");
      expect(JSON.stringify(card.elements)).toContain("project-alpha");
    } finally {
      await app.close();
      rmSync(fixture.sessionsRoot, { recursive: true, force: true });
    }
  });

  it("supports project-path scanning card and allows selecting a folder project in fresh environment", async () => {
    const fixture = createFeishuProjectPathScanFixture();
    const mockOpenApi = createFeishuOpenApiMock();
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      fetchImpl: mockOpenApi.fetchImpl,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuVerifyToken: "verify-token",
        feishuOpenBaseUrl: "http://mock.feishu",
        codexAutoDispatchEnabled: false,
        codexLocalSessionsScanEnabled: true,
        codexLocalSessionsRoot: fixture.sessionsRoot,
        codexLocalSessionsScanIntervalMs: 1000
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

      const scanResponse = await app.inject({
        method: "POST",
        url: "/api/feishu/webhook",
        headers: {
          "x-lark-request-token": "verify-token"
        },
        payload: {
          event: {
            type: "im.message.receive_v1",
            message: {
              message_id: "msg-panel-project-path-scan",
              message_type: "text",
              content: `{"text":"选择项目路径：${fixture.projectRoot}"}`
            },
            sender: {
              sender_id: {
                open_id: "ou_panel_path_scan_user"
              }
            }
          }
        }
      });

      expect(scanResponse.statusCode).toBe(200);
      expect(scanResponse.json()).toEqual(
        expect.objectContaining({
          accepted: true,
          command: "view_projects_by_path",
          context: expect.objectContaining({
            currentView: "project_list"
          })
        })
      );

      expect(mockOpenApi.messageBodies).toHaveLength(1);
      const pathScanCard = parseOutboundInteractiveCard(mockOpenApi.messageBodies[0]);
      // title text can vary with card locale/encoding
      expect(JSON.stringify(pathScanCard.elements)).toContain("demo-project-a");
      expect(JSON.stringify(pathScanCard.elements)).toContain("demo-project-b");
      expect(JSON.stringify(pathScanCard.elements)).not.toContain(".hidden-project");

      const selectProjectResponse = await app.inject({
        method: "POST",
        url: "/api/feishu/webhook",
        headers: {
          "x-lark-request-token": "verify-token"
        },
        payload: {
          event: {
            type: "im.message.receive_v1",
            message: {
              message_id: "msg-panel-project-path-select-project",
              message_type: "text",
              content: `{"text":"选择项目：${fixture.projectAPath}"}`
            },
            sender: {
              sender_id: {
                open_id: "ou_panel_path_scan_user"
              }
            }
          }
        }
      });

      expect(selectProjectResponse.statusCode).toBe(200);
      expect(selectProjectResponse.json()).toEqual(
        expect.objectContaining({
          accepted: true,
          command: "select_project",
          context: expect.objectContaining({
            currentView: "session_list",
            selectedProjectPath: fixture.projectAPath
          })
        })
      );
    } finally {
      await app.close();
      rmSync(fixture.sessionsRoot, { recursive: true, force: true });
    }
  });

  it("supports panel continuous selection and dispatches plain text into selected session", async () => {
    const fixture = createFeishuPanelSessionsFixture();
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuVerifyToken: "verify-token",
        codexAutoDispatchEnabled: false,
        codexLocalSessionsScanEnabled: true,
        codexLocalSessionsRoot: fixture.sessionsRoot,
        codexLocalSessionsScanIntervalMs: 1000
      }
    });

    try {
      const viewProjectsResponse = await app.inject({
        method: "POST",
        url: "/api/feishu/webhook",
        headers: {
          "x-lark-request-token": "verify-token"
        },
        payload: {
          event: {
            type: "im.message.receive_v1",
            message: {
              message_id: "msg-panel-chain-view",
              message_type: "text",
              content: "{\"text\":\"鏌ョ湅椤圭洰\"}"
            },
            sender: {
              sender_id: {
                open_id: "ou_panel_chain_user"
              }
            }
          }
        }
      });
      expect(viewProjectsResponse.statusCode).toBe(200);
      expect(viewProjectsResponse.json().context.currentView).toBe("project_list");

      const selectProjectResponse = await app.inject({
        method: "POST",
        url: "/api/feishu/webhook",
        headers: {
          "x-lark-request-token": "verify-token"
        },
        payload: {
          event: {
            type: "im.message.receive_v1",
            message: {
              message_id: "msg-panel-chain-select-project",
              message_type: "text",
              content: `{"text":"閫夋嫨椤圭洰锛?{fixture.projectAlphaPath}"}`
            },
            sender: {
              sender_id: {
                open_id: "ou_panel_chain_user"
              }
            }
          }
        }
      });
      expect(selectProjectResponse.statusCode).toBe(200);
      expect(selectProjectResponse.json()).toEqual(
        expect.objectContaining({
          accepted: true,
          command: "select_project",
          context: expect.objectContaining({
            currentView: "session_list",
            selectedProjectPath: fixture.projectAlphaPath
          })
        })
      );

      const selectSessionResponse = await app.inject({
        method: "POST",
        url: "/api/feishu/webhook",
        headers: {
          "x-lark-request-token": "verify-token"
        },
        payload: {
          event: {
            type: "im.message.receive_v1",
            message: {
              message_id: "msg-panel-chain-select-session",
              message_type: "text",
              content: `{"text":"閫夋嫨session锛?{fixture.threadAlpha1}"}`
            },
            sender: {
              sender_id: {
                open_id: "ou_panel_chain_user"
              }
            }
          }
        }
      });
      expect(selectSessionResponse.statusCode).toBe(200);
      expect(selectSessionResponse.json()).toEqual(
        expect.objectContaining({
          accepted: true,
          command: "select_session",
          context: expect.objectContaining({
            currentView: "selection",
            selectedProjectPath: fixture.projectAlphaPath,
            selectedThreadId: fixture.threadAlpha1
          })
        })
      );

      const dispatchResponse = await app.inject({
        method: "POST",
        url: "/api/feishu/webhook",
        headers: {
          "x-lark-request-token": "verify-token"
        },
        payload: {
          event: {
            type: "im.message.receive_v1",
            message: {
              message_id: "msg-panel-chain-dispatch",
              message_type: "text",
              content: "{\"text\":\"继续把卡片按钮补齐\"}"
            },
            sender: {
              sender_id: {
                open_id: "ou_panel_chain_user"
              }
            }
          }
        }
      });
      expect(dispatchResponse.statusCode).toBe(200);
      expect(dispatchResponse.json()).toEqual(
        expect.objectContaining({
          accepted: true,
          sessionId: fixture.threadAlpha1,
          dispatch: expect.objectContaining({
            skipped: true,
            reason: "dispatch_disabled"
          })
        })
      );
    } finally {
      await app.close();
      rmSync(fixture.sessionsRoot, { recursive: true, force: true });
    }
  });

  it("handles card.action.trigger with the same panel command flow", async () => {
    const fixture = createFeishuPanelSessionsFixture();
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuVerifyToken: "verify-token",
        codexLocalSessionsScanEnabled: true,
        codexLocalSessionsRoot: fixture.sessionsRoot,
        codexLocalSessionsScanIntervalMs: 1000
      }
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/feishu/webhook",
        headers: {
          "x-lark-request-token": "verify-token"
        },
        payload: {
          event: {
            type: "card.action.trigger",
            context: {
              open_message_id: "msg-card-action-1",
              open_chat_id: "chat-card-action-1"
            },
            operator: {
              open_id: "ou_panel_card_action_user"
            },
            action: {
              tag: "button",
              value: {
                panelAction: "view_projects"
              }
            }
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.objectContaining({
          accepted: true,
          command: "view_projects",
          context: expect.objectContaining({
            currentView: "project_list"
          })
        })
      );
    } finally {
      await app.close();
      rmSync(fixture.sessionsRoot, { recursive: true, force: true });
    }
  });

  it("supports stop_task card action on running task cards", async () => {
    const mockOpenApi = createFeishuOpenApiMock();
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      fetchImpl: mockOpenApi.fetchImpl,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuVerifyToken: "verify-token",
        feishuOpenBaseUrl: "http://mock.feishu"
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

      const createTask = await app.inject({
        method: "POST",
        url: "/api/feishu/webhook",
        headers: {
          "x-lark-request-token": "verify-token"
        },
        payload: {
          event: {
            type: "im.message.receive_v1",
            message: {
              message_id: "msg-stop-task-create",
              message_type: "text",
              content: "{\"text\":\"#session:feishu-stop-card 淇鍋滄鎸夐挳\"}"
            },
            sender: {
              sender_id: {
                open_id: "ou_stop_task_user"
              }
            }
          }
        }
      });

      const created = createTask.json() as {
        accepted: boolean;
        taskId?: string;
        sessionId?: string;
      };
      expect(created.accepted).toBe(true);
      expect(created.taskId).toBeTruthy();
      expect(created.sessionId).toBe("feishu-stop-card");

      expect(mockOpenApi.messageBodies.length).toBeGreaterThan(0);
      const runningCardPayload = parseOutboundInteractiveCard(mockOpenApi.messageBodies[0]);
      const runningCardText = JSON.stringify(runningCardPayload.elements);
      expect(runningCardText).toContain("\"panelAction\":\"stop_task\"");
      expect(runningCardText).toContain(created.taskId!);

      const stopTask = await app.inject({
        method: "POST",
        url: "/api/feishu/webhook",
        headers: {
          "x-lark-request-token": "verify-token"
        },
        payload: {
          event: {
            type: "card.action.trigger",
            context: {
              open_message_id: "msg-stop-task-card",
              open_chat_id: "chat-stop-task-card"
            },
            operator: {
              open_id: "ou_stop_task_user"
            },
            action: {
              tag: "button",
              value: {
                panelAction: "stop_task",
                taskId: created.taskId,
                sessionId: created.sessionId
              }
            }
          }
        }
      });

      expect(stopTask.statusCode).toBe(200);
      expect(stopTask.json()).toEqual(
        expect.objectContaining({
          accepted: true,
          command: "stop_task",
          operation: expect.objectContaining({
            success: true,
            taskId: created.taskId,
            status: "stopped",
            changed: true
          })
        })
      );

      const taskDetail = await app.inject({
        method: "GET",
        url: `/api/tasks/${created.taskId}/detail`
      });
      expect(taskDetail.statusCode).toBe(200);
      expect(taskDetail.json().status).toBe("stopped");
    } finally {
      await app.close();
    }
  });

  it("switches to selected session from card action and replies with direct-reply tip", async () => {
    const fixture = createFeishuPanelSessionsFixture();
    const mockOpenApi = createFeishuOpenApiMock();
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      fetchImpl: mockOpenApi.fetchImpl,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuVerifyToken: "verify-token",
        feishuOpenBaseUrl: "http://mock.feishu",
        codexLocalSessionsScanEnabled: true,
        codexLocalSessionsRoot: fixture.sessionsRoot,
        codexLocalSessionsScanIntervalMs: 1000
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
            type: "card.action.trigger",
            context: {
              open_message_id: "msg-card-action-select-session",
              open_chat_id: "chat-card-action-select-session"
            },
            operator: {
              open_id: "ou_panel_select_session_user"
            },
            action: {
              tag: "button",
              value: {
                panelAction: "select_session",
                selector: fixture.threadAlpha1,
                threadId: fixture.threadAlpha1
              }
            }
          }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.objectContaining({
          accepted: true,
          command: "select_session",
          context: expect.objectContaining({
            selectedThreadId: fixture.threadAlpha1,
            currentView: "selection"
          })
        })
      );

      expect(mockOpenApi.messageBodies).toHaveLength(1);
      const outbound = JSON.parse(mockOpenApi.messageBodies[0]) as {
        receive_id: string;
        msg_type: string;
        content: string;
      };
      expect(outbound.receive_id).toBe("chat-card-action-select-session");
      expect(outbound.msg_type).toBe("interactive");
      expect(outbound.content).toContain("已切换到此会话");
    } finally {
      await app.close();
      rmSync(fixture.sessionsRoot, { recursive: true, force: true });
    }
  });

  it("returns quickly for session card actions even when outbound card notify is slow", async () => {
    const fixture = createFeishuPanelSessionsFixture();
    const fetchCalls: string[] = [];
    const hangingFetch = ((input: string | URL | Request) => {
      fetchCalls.push(String(input));
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      fetchImpl: hangingFetch,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuVerifyToken: "verify-token",
        feishuOpenBaseUrl: "http://mock.feishu",
        codexLocalSessionsScanEnabled: true,
        codexLocalSessionsRoot: fixture.sessionsRoot,
        codexLocalSessionsScanIntervalMs: 1000
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

      const response = await Promise.race([
        app.inject({
          method: "POST",
          url: "/api/feishu/webhook",
          headers: {
            "x-lark-request-token": "verify-token"
          },
          payload: {
            event: {
              type: "card.action.trigger",
              context: {
                open_message_id: "msg-card-action-select-session-fast",
                open_chat_id: "chat-card-action-select-session-fast"
              },
              operator: {
                open_id: "ou_panel_select_session_user"
              },
              action: {
                tag: "button",
                value: {
                  panelAction: "select_session",
                  selector: fixture.threadAlpha1,
                  threadId: fixture.threadAlpha1
                }
              }
            }
          }
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("card action callback timed out")), 1000);
        })
      ]);

      expect((response as { statusCode: number }).statusCode).toBe(200);
      expect((response as { json: () => unknown }).json()).toEqual(
        expect.objectContaining({
          accepted: true,
          command: "select_session",
          context: expect.objectContaining({
            selectedThreadId: fixture.threadAlpha1,
            currentView: "selection"
          })
        })
      );
      expect(fetchCalls.length).toBeGreaterThan(0);
    } finally {
      await app.close();
      rmSync(fixture.sessionsRoot, { recursive: true, force: true });
    }
  });

  it("supports session list pagination and 24h/7d quick filters in panel card actions", async () => {
    const fixture = createFeishuPanelPaginationFixture();
    const mockOpenApi = createFeishuOpenApiMock();
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      fetchImpl: mockOpenApi.fetchImpl,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuVerifyToken: "verify-token",
        feishuOpenBaseUrl: "http://mock.feishu",
        codexLocalSessionsScanEnabled: true,
        codexLocalSessionsRoot: fixture.sessionsRoot,
        codexLocalSessionsScanIntervalMs: 1000
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

      const selectProjectResponse = await app.inject({
        method: "POST",
        url: "/api/feishu/webhook",
        headers: {
          "x-lark-request-token": "verify-token"
        },
        payload: {
          event: {
            type: "im.message.receive_v1",
            message: {
              message_id: "msg-panel-pagination-select-project",
              message_type: "text",
              content: "{\"text\":\"閫夋嫨椤圭洰锛歱roject-pagination\"}"
            },
            sender: {
              sender_id: {
                open_id: "ou_panel_pagination_user"
              }
            }
          }
        }
      });

      expect(selectProjectResponse.statusCode).toBe(200);
      expect(selectProjectResponse.json()).toEqual(
        expect.objectContaining({
          accepted: true,
          command: "select_project",
          context: expect.objectContaining({
            currentView: "session_list",
            selectedProjectPath: fixture.projectPath
          })
        })
      );

      const firstCardPayload = JSON.parse(mockOpenApi.messageBodies[mockOpenApi.messageBodies.length - 1]) as {
        content: string;
      };
      expect(firstCardPayload.content).toContain("第 1/2 页");
      expect(firstCardPayload.content).toContain("下一页");
      expect(firstCardPayload.content).toContain("鏈€杩?4h");
      expect(firstCardPayload.content).toContain("鏈€杩?d");

      const nextPageResponse = await app.inject({
        method: "POST",
        url: "/api/feishu/webhook",
        headers: {
          "x-lark-request-token": "verify-token"
        },
        payload: {
          event: {
            type: "card.action.trigger",
            context: {
              open_message_id: "msg-panel-pagination-next",
              open_chat_id: "chat-panel-pagination-next"
            },
            operator: {
              open_id: "ou_panel_pagination_user"
            },
            action: {
              tag: "button",
              value: {
                panelAction: "view_project_sessions",
                page: 2,
                window: "all"
              }
            }
          }
        }
      });

      expect(nextPageResponse.statusCode).toBe(200);
      expect(nextPageResponse.json()).toEqual(
        expect.objectContaining({
          accepted: true,
          command: "view_project_sessions",
          context: expect.objectContaining({
            lastAction: "view_project_sessions:window=all:page=2"
          })
        })
      );

      const page2CardPayload = JSON.parse(mockOpenApi.messageBodies[mockOpenApi.messageBodies.length - 1]) as {
        content: string;
      };
      expect(page2CardPayload.content).toContain("第 2/2 页");
      expect(page2CardPayload.content).toContain("上一页");

      const filter24hResponse = await app.inject({
        method: "POST",
        url: "/api/feishu/webhook",
        headers: {
          "x-lark-request-token": "verify-token"
        },
        payload: {
          event: {
            type: "card.action.trigger",
            context: {
              open_message_id: "msg-panel-pagination-filter-24h",
              open_chat_id: "chat-panel-pagination-filter-24h"
            },
            operator: {
              open_id: "ou_panel_pagination_user"
            },
            action: {
              tag: "button",
              value: {
                panelAction: "view_project_sessions",
                page: 1,
                window: "24h"
              }
            }
          }
        }
      });

      expect(filter24hResponse.statusCode).toBe(200);
      expect(filter24hResponse.json()).toEqual(
        expect.objectContaining({
          accepted: true,
          command: "view_project_sessions",
          context: expect.objectContaining({
            lastAction: "view_project_sessions:window=24h:page=1"
          })
        })
      );

      const filter24hCardPayload = JSON.parse(mockOpenApi.messageBodies[mockOpenApi.messageBodies.length - 1]) as {
        content: string;
      };
      expect(filter24hCardPayload.content).toContain("绛涢€夎寖鍥达細鏈€杩?4灏忔椂");
      expect(filter24hCardPayload.content).toContain("绛涢€夊悗浼氳瘽鏁帮細9");
    } finally {
      await app.close();
      rmSync(fixture.sessionsRoot, { recursive: true, force: true });
    }
  });

  it("accepts plain task input after clicking compose_session_command", async () => {
    const fixture = createFeishuPanelSessionsFixture();
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuVerifyToken: "verify-token",
        codexAutoDispatchEnabled: false,
        codexLocalSessionsScanEnabled: true,
        codexLocalSessionsRoot: fixture.sessionsRoot,
        codexLocalSessionsScanIntervalMs: 1000
      }
    });

    try {
      const selectSessionResponse = await app.inject({
        method: "POST",
        url: "/api/feishu/webhook",
        headers: {
          "x-lark-request-token": "verify-token"
        },
        payload: {
          event: {
            type: "im.message.receive_v1",
            message: {
              message_id: "msg-compose-session-select",
              message_type: "text",
              content: `{"text":"閫夋嫨session锛?{fixture.threadAlpha1}"}`
            },
            sender: {
              sender_id: {
                open_id: "ou_compose_session_user"
              }
            }
          }
        }
      });
      expect(selectSessionResponse.statusCode).toBe(200);
      expect(selectSessionResponse.json().context.selectedThreadId).toBe(fixture.threadAlpha1);

      const composeResponse = await app.inject({
        method: "POST",
        url: "/api/feishu/webhook",
        headers: {
          "x-lark-request-token": "verify-token"
        },
        payload: {
          event: {
            type: "card.action.trigger",
            context: {
              open_message_id: "msg-compose-session-card",
              open_chat_id: "chat-compose-session-card"
            },
            operator: {
              open_id: "ou_compose_session_user"
            },
            action: {
              tag: "button",
              value: {
                panelAction: "compose_session_command"
              }
            }
          }
        }
      });
      expect(composeResponse.statusCode).toBe(200);
      expect(composeResponse.json()).toEqual(
        expect.objectContaining({
          accepted: true,
          command: "compose_session_command",
          context: expect.objectContaining({
            pendingComposeMode: "session_command"
          })
        })
      );

      const dispatchResponse = await app.inject({
        method: "POST",
        url: "/api/feishu/webhook",
        headers: {
          "x-lark-request-token": "verify-token"
        },
        payload: {
          event: {
            type: "im.message.receive_v1",
            message: {
              message_id: "msg-compose-session-dispatch",
              message_type: "text",
              content: "{\"text\":\"淇鐧诲綍鎺ュ彛 500\"}"
            },
            sender: {
              sender_id: {
                open_id: "ou_compose_session_user"
              }
            }
          }
        }
      });
      expect(dispatchResponse.statusCode).toBe(200);
      expect(dispatchResponse.json()).toEqual(
        expect.objectContaining({
          accepted: true,
          sessionId: fixture.threadAlpha1,
          dispatch: expect.objectContaining({
            skipped: true,
            reason: "dispatch_disabled"
          })
        })
      );

      const currentSelectionResponse = await app.inject({
        method: "POST",
        url: "/api/feishu/webhook",
        headers: {
          "x-lark-request-token": "verify-token"
        },
        payload: {
          event: {
            type: "im.message.receive_v1",
            message: {
              message_id: "msg-compose-session-current",
              message_type: "text",
              content: "{\"text\":\"褰撳墠閫夋嫨\"}"
            },
            sender: {
              sender_id: {
                open_id: "ou_compose_session_user"
              }
            }
          }
        }
      });
      expect(currentSelectionResponse.statusCode).toBe(200);
      expect(currentSelectionResponse.json().context.pendingComposeMode).toBeNull();
    } finally {
      await app.close();
      rmSync(fixture.sessionsRoot, { recursive: true, force: true });
    }
  });

  it("shows a primary new session button after selecting a project and starts a fresh session", async () => {
    const fixture = createFeishuPanelSessionsFixture();
    const mockOpenApi = createFeishuOpenApiMock();
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      fetchImpl: mockOpenApi.fetchImpl,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuVerifyToken: "verify-token",
        feishuOpenBaseUrl: "http://mock.feishu",
        codexAutoDispatchEnabled: false,
        codexLocalSessionsScanEnabled: true,
        codexLocalSessionsRoot: fixture.sessionsRoot,
        codexLocalSessionsScanIntervalMs: 1000
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

      const selectProjectResponse = await app.inject({
        method: "POST",
        url: "/api/feishu/webhook",
        headers: {
          "x-lark-request-token": "verify-token"
        },
        payload: {
          event: {
            type: "im.message.receive_v1",
            message: {
              message_id: "msg-project-session-select-project",
              message_type: "text",
              content: `{"text":"閫夋嫨椤圭洰锛?{fixture.projectAlphaPath}"}`
            },
            sender: {
              sender_id: {
                open_id: "ou_project_session_user"
              }
            }
          }
        }
      });

      expect(selectProjectResponse.statusCode).toBe(200);
      expect(selectProjectResponse.json()).toEqual(
        expect.objectContaining({
          accepted: true,
          command: "select_project",
          context: expect.objectContaining({
            currentView: "session_list",
            selectedProjectPath: fixture.projectAlphaPath
          })
        })
      );

      expect(mockOpenApi.messageBodies).toHaveLength(1);
      const projectSessionCard = parseOutboundInteractiveCard(mockOpenApi.messageBodies[0]);
      const sessionActionBlock = projectSessionCard.elements.find((item) => item.tag === "action" && Array.isArray(item.actions));
      const newSessionButton = sessionActionBlock?.actions?.find((button) => button.text?.content === "鏂板缓 session");
      expect(newSessionButton).toEqual(
        expect.objectContaining({
          type: "primary"
        })
      );

      const composeResponse = await app.inject({
        method: "POST",
        url: "/api/feishu/webhook",
        headers: {
          "x-lark-request-token": "verify-token"
        },
        payload: {
          event: {
            type: "card.action.trigger",
            context: {
              open_message_id: "msg-project-session-compose-card",
              open_chat_id: "chat-project-session-compose-card"
            },
            operator: {
              open_id: "ou_project_session_user"
            },
            action: {
              tag: "button",
              value: {
                panelAction: "compose_project_session_command"
              }
            }
          }
        }
      });

      expect(composeResponse.statusCode).toBe(200);
      expect(composeResponse.json()).toEqual(
        expect.objectContaining({
          accepted: true,
          command: "compose_project_session_command",
          context: expect.objectContaining({
            pendingComposeMode: "project_session_command"
          })
        })
      );

      expect(mockOpenApi.messageBodies).toHaveLength(2);
      const composeGuideCard = parseOutboundInteractiveCard(mockOpenApi.messageBodies[1]);
      expect(composeGuideCard.header?.template).toBe("green");
      expect(composeGuideCard.header?.title?.content).toBe("新建 session 模式已开启");

      const dispatchResponse = await app.inject({
        method: "POST",
        url: "/api/feishu/webhook",
        headers: {
          "x-lark-request-token": "verify-token"
        },
        payload: {
          event: {
            type: "im.message.receive_v1",
            message: {
              message_id: "msg-project-session-dispatch",
              message_type: "text",
              content: "{\"text\":\"缁х画浼樺寲鍗＄墖鎸夐挳鏍峰紡\"}"
            },
            sender: {
              sender_id: {
                open_id: "ou_project_session_user"
              }
            }
          }
        }
      });

      expect(dispatchResponse.statusCode).toBe(200);
      const dispatchJson = dispatchResponse.json() as {
        accepted: boolean;
        sessionId: string;
        dispatch?: {
          skipped?: boolean;
          reason?: string;
        };
      };
      expect(dispatchJson).toEqual(
        expect.objectContaining({
          accepted: true,
          sessionId: expect.any(String),
          dispatch: expect.objectContaining({
            skipped: true,
            reason: "dispatch_disabled"
          })
        })
      );
      expect(dispatchJson.sessionId).not.toBe(fixture.threadAlpha1);
      expect(dispatchJson.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    } finally {
      await app.close();
      rmSync(fixture.sessionsRoot, { recursive: true, force: true });
    }
  });

  it("accepts plain task input after clicking compose_thread_command", async () => {
    const fixture = createFeishuPanelSessionsFixture();
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuVerifyToken: "verify-token",
        codexAutoDispatchEnabled: false,
        codexLocalSessionsScanEnabled: true,
        codexLocalSessionsRoot: fixture.sessionsRoot,
        codexLocalSessionsScanIntervalMs: 1000
      }
    });

    try {
      const selectSessionResponse = await app.inject({
        method: "POST",
        url: "/api/feishu/webhook",
        headers: {
          "x-lark-request-token": "verify-token"
        },
        payload: {
          event: {
            type: "im.message.receive_v1",
            message: {
              message_id: "msg-compose-thread-select",
              message_type: "text",
              content: `{"text":"閫夋嫨session锛?{fixture.threadAlpha2}"}`
            },
            sender: {
              sender_id: {
                open_id: "ou_compose_thread_user"
              }
            }
          }
        }
      });
      expect(selectSessionResponse.statusCode).toBe(200);
      expect(selectSessionResponse.json().context.selectedThreadId).toBe(fixture.threadAlpha2);

      const composeResponse = await app.inject({
        method: "POST",
        url: "/api/feishu/webhook",
        headers: {
          "x-lark-request-token": "verify-token"
        },
        payload: {
          event: {
            type: "card.action.trigger",
            context: {
              open_message_id: "msg-compose-thread-card",
              open_chat_id: "chat-compose-thread-card"
            },
            operator: {
              open_id: "ou_compose_thread_user"
            },
            action: {
              tag: "button",
              value: {
                panelAction: "compose_thread_command"
              }
            }
          }
        }
      });
      expect(composeResponse.statusCode).toBe(200);
      expect(composeResponse.json()).toEqual(
        expect.objectContaining({
          accepted: true,
          command: "compose_thread_command",
          context: expect.objectContaining({
            pendingComposeMode: "thread_command"
          })
        })
      );

      const dispatchResponse = await app.inject({
        method: "POST",
        url: "/api/feishu/webhook",
        headers: {
          "x-lark-request-token": "verify-token"
        },
        payload: {
          event: {
            type: "im.message.receive_v1",
            message: {
              message_id: "msg-compose-thread-dispatch",
              message_type: "text",
              content: "{\"text\":\"继续完成状态卡片优化\"}"
            },
            sender: {
              sender_id: {
                open_id: "ou_compose_thread_user"
              }
            }
          }
        }
      });
      expect(dispatchResponse.statusCode).toBe(200);
      expect(dispatchResponse.json()).toEqual(
        expect.objectContaining({
          accepted: true,
          sessionId: fixture.threadAlpha2,
          threadRef: fixture.threadAlpha2,
          dispatch: expect.objectContaining({
            skipped: true,
            reason: "dispatch_disabled",
            threadRef: fixture.threadAlpha2
          })
        })
      );
    } finally {
      await app.close();
      rmSync(fixture.sessionsRoot, { recursive: true, force: true });
    }
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
          content: "{\"text\":\"#session:feishu-codex-dup 淇閲嶅浜嬩欢\"}"
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

  it("ignores group message when bot is not mentioned", async () => {
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
            message_id: "msg-group-ignore-1",
            message_type: "text",
            chat_id: "oc_group_ignore_1",
            chat_type: "group",
            content: "{\"text\":\"#session:group-ignore-session 这条消息没有@机器人\"}"
          },
          sender: {
            sender_id: {
              open_id: "ou_group_ignore_user"
            }
          }
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        accepted: true,
        ignored: true,
        reason: "group_not_mentioned"
      })
    );

    const tasks = await app.inject({
      method: "GET",
      url: "/api/codex/tasks?limit=20"
    });
    expect(tasks.statusCode).toBe(200);
    expect(tasks.json().items).toHaveLength(0);

    await app.close();
  });

  it("keeps group chat routing consistent from feishu command to codex completion", async () => {
    const mockOpenApi = createFeishuOpenApiMock();
    const db = createSqliteDatabase(":memory:");
    migrateDatabase(db);

    const app = buildApp({
      db,
      fetchImpl: mockOpenApi.fetchImpl,
      env: {
        databasePath: ":memory:",
        logLevel: "silent",
        feishuVerifyToken: "verify-token",
        feishuOpenBaseUrl: "http://mock.feishu"
      }
    });

    try {
      const currentConfig = await app.inject({
        method: "GET",
        url: "/api/connectors/feishu/config"
      });
      await app.inject({
        method: "PUT",
        url: "/api/connectors/feishu/config",
        payload: {
          ...(currentConfig.json() as Record<string, unknown>),
          enabled: true,
          appId: "app-id",
          appSecret: "app-secret",
          callbackUrl: "",
          templateTaskStarted: "任务开始",
          templateTaskSucceeded: "浠诲姟鎴愬姛",
          templateTaskFailed: "浠诲姟澶辫触",
          templateTaskPendingConfirm: "请确认"
        }
      });

      const inbound = await app.inject({
        method: "POST",
        url: "/api/feishu/webhook",
        headers: {
          "x-lark-request-token": "verify-token"
        },
        payload: {
          event: {
            type: "im.message.receive_v1",
            message: {
              message_id: "msg-group-route-1",
              message_type: "text",
              chat_id: "oc_group_route_1",
              chat_type: "group",
              content:
                "{\"text\":\"@鏈哄櫒浜?#session:group-route-session 淇缇よ亰璺敱\",\"mentions\":[{\"id\":{\"open_id\":\"ou_bot_demo\"}}]}",
              mentions: [
                {
                  id: {
                    open_id: "ou_bot_demo"
                  }
                }
              ]
            },
            sender: {
              sender_id: {
                open_id: "ou_group_route_user"
              }
            }
          }
        }
      });

      expect(inbound.statusCode).toBe(200);
      const inboundBody = inbound.json() as {
        accepted: boolean;
        sessionId: string;
      };
      expect(inboundBody.accepted).toBe(true);

      const firstNotifyPayload = JSON.parse(mockOpenApi.messageBodies[0]) as {
        receive_id: string;
        msg_type: string;
      };
      expect(firstNotifyPayload.receive_id).toBe("oc_group_route_1");
      expect(firstNotifyPayload.msg_type).toBe("interactive");

      const codexDone = await app.inject({
        method: "POST",
        url: "/api/codex/events",
        payload: {
          eventId: "evt-group-route-1",
          taskId: "task-group-route-1",
          sessionId: inboundBody.sessionId,
          status: "succeeded",
          summary: "缇よ亰璺敱鍥炴帹鏍￠獙閫氳繃",
          detail: "瀹屾垚鍥炴帹",
          senderId: "codex_runner"
        }
      });
      expect(codexDone.statusCode).toBe(200);
      expect(codexDone.json()).toEqual(
        expect.objectContaining({
          accepted: true
        })
      );

      expect(mockOpenApi.messageBodies.length).toBeGreaterThanOrEqual(2);
      const secondNotifyPayload = JSON.parse(mockOpenApi.messageBodies[1]) as {
        receive_id: string;
        msg_type: string;
      };
      expect(secondNotifyPayload.receive_id).toBe("oc_group_route_1");
      expect(secondNotifyPayload.msg_type).toBe("interactive");
    } finally {
      await app.close();
    }
  });
});
