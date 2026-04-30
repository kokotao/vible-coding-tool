import { buildApp } from "../../src/app";
import { createQqRequestSignature } from "../../src/modules/qq/qq-security";
import { createFetchMock } from "../helpers/fetch-mock";

function createQqApiV2Mock() {
  const tokenBodies: string[] = [];
  const privateBodies: string[] = [];
  const groupBodies: string[] = [];
  const interactionBodies: string[] = [];
  const { fetchImpl, calls } = createFetchMock([
    {
      match: "https://bots.qq.com/app/getAppAccessToken",
      response: ({ bodyText }) => {
        tokenBodies.push(bodyText);
        return new Response(
          JSON.stringify({
            access_token: "qq-app-token",
            expires_in: 7200
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
      match: /\/v2\/users\/[^/]+\/messages$/,
      response: ({ bodyText }) => {
        privateBodies.push(bodyText);
        return new Response(
          JSON.stringify({
            id: "msg-private-1"
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
      match: /\/v2\/groups\/[^/]+\/messages$/,
      response: ({ bodyText }) => {
        groupBodies.push(bodyText);
        return new Response(
          JSON.stringify({
            id: "msg-group-1"
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
      match: /\/interactions\/[^/]+$/,
      response: ({ bodyText }) => {
        interactionBodies.push(bodyText);
        return new Response(
          JSON.stringify({
            code: 0
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          }
        );
      }
    }
  ]);

  return {
    calls,
    fetchImpl,
    tokenBodies,
    privateBodies,
    groupBodies,
    interactionBodies
  };
}

function buildSignedQqWebhookRequest(secret: string, payload: unknown, timestamp = "1710000000") {
  const rawBody = JSON.stringify(payload);
  return {
    payload: rawBody,
    headers: {
      "content-type": "application/json",
      "x-signature-timestamp": timestamp,
      "x-signature-ed25519": createQqRequestSignature({
        secret,
        timestamp,
        rawBody
      })
    }
  };
}

describe("qq webhook api", () => {
  it("responds QQ callback challenge with plain_token + signature", async () => {
    const app = buildApp({
      env: {
        databasePath: ":memory:",
        logLevel: "silent"
      }
    });

    try {
      const currentConfig = (
        await app.inject({
          method: "GET",
          url: "/api/connectors/qq/config"
        })
      ).json();

      const updateConfig = await app.inject({
        method: "PUT",
        url: "/api/connectors/qq/config",
        payload: {
          ...currentConfig,
          platform: "qq",
          enabled: true,
          appSecret: "qq-secret-demo"
        }
      });
      expect(updateConfig.statusCode).toBe(200);

      const challengePayload = {
        op: 13,
        d: {
          plain_token: "plain_token_demo",
          event_ts: "1710000000"
        }
      };
      const signedRequest = buildSignedQqWebhookRequest("qq-secret-demo", challengePayload);

      const response = await app.inject({
        method: "POST",
        url: "/api/qq/webhook",
        payload: signedRequest.payload,
        headers: signedRequest.headers
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json() as { plain_token: string; signature: string };
      expect(payload.plain_token).toBe("plain_token_demo");
      expect(payload.signature).toMatch(/^[0-9a-f]+$/i);
      expect(payload.signature.length).toBeGreaterThan(32);
    } finally {
      await app.close();
    }
  });

  it("rejects callback when signature headers are missing and secret is configured", async () => {
    const app = buildApp({
      env: {
        databasePath: ":memory:",
        logLevel: "silent"
      }
    });

    try {
      const currentConfig = (
        await app.inject({
          method: "GET",
          url: "/api/connectors/qq/config"
        })
      ).json();

      const updateConfig = await app.inject({
        method: "PUT",
        url: "/api/connectors/qq/config",
        payload: {
          ...currentConfig,
          platform: "qq",
          enabled: true,
          appSecret: "qq-secret-demo"
        }
      });
      expect(updateConfig.statusCode).toBe(200);

      const response = await app.inject({
        method: "POST",
        url: "/api/qq/webhook",
        payload: {
          id: "evt-missing-signature",
          op: 0,
          t: "C2C_MESSAGE_CREATE",
          d: {
            id: "msg-1",
            content: "#session:qq-demo hello",
            author: {
              user_openid: "uid_missing_signature"
            }
          }
        }
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        code: "QQ_VERIFY_FAILED"
      });
    } finally {
      await app.close();
    }
  });

  it("rejects callback when signature is invalid", async () => {
    const app = buildApp({
      env: {
        databasePath: ":memory:",
        logLevel: "silent"
      }
    });

    try {
      const currentConfig = (
        await app.inject({
          method: "GET",
          url: "/api/connectors/qq/config"
        })
      ).json();

      const updateConfig = await app.inject({
        method: "PUT",
        url: "/api/connectors/qq/config",
        payload: {
          ...currentConfig,
          platform: "qq",
          enabled: true,
          appSecret: "qq-secret-demo"
        }
      });
      expect(updateConfig.statusCode).toBe(200);

      const payload = {
        id: "evt-invalid-signature",
        op: 0,
        t: "C2C_MESSAGE_CREATE",
        d: {
          id: "msg-2",
          content: "#session:qq-demo hello",
          author: {
            user_openid: "uid_invalid_signature"
          }
        }
      };

      const response = await app.inject({
        method: "POST",
        url: "/api/qq/webhook",
        payload: JSON.stringify(payload),
        headers: {
          "content-type": "application/json",
          "x-signature-timestamp": "1710000000",
          "x-signature-ed25519": "deadbeef"
        }
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        code: "QQ_VERIFY_FAILED"
      });
    } finally {
      await app.close();
    }
  });

  it("ignores empty text callback message with accepted response", async () => {
    const app = buildApp({
      env: {
        databasePath: ":memory:",
        logLevel: "silent"
      }
    });

    try {
      const currentConfig = (
        await app.inject({
          method: "GET",
          url: "/api/connectors/qq/config"
        })
      ).json();

      const updateConfig = await app.inject({
        method: "PUT",
        url: "/api/connectors/qq/config",
        payload: {
          ...currentConfig,
          platform: "qq",
          enabled: true,
          appSecret: "qq-secret-demo"
        }
      });
      expect(updateConfig.statusCode).toBe(200);

      const eventPayload = {
        id: "evt-empty-message",
        op: 0,
        t: "C2C_MESSAGE_CREATE",
        d: {
          id: "msg-empty-message",
          content: "   ",
          author: {
            user_openid: "uid_empty_message"
          }
        }
      };
      const signedRequest = buildSignedQqWebhookRequest("qq-secret-demo", eventPayload);
      const response = await app.inject({
        method: "POST",
        url: "/api/qq/webhook",
        payload: signedRequest.payload,
        headers: signedRequest.headers
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        accepted: true,
        ignored: true,
        reason: "empty_message"
      });
    } finally {
      await app.close();
    }
  });

  it("accepts C2C command and sends private message through QQ API v2", async () => {
    const qqMock = createQqApiV2Mock();
    const app = buildApp({
      env: {
        databasePath: ":memory:",
        logLevel: "silent"
      },
      fetchImpl: qqMock.fetchImpl
    });

    try {
      const currentConfig = (
        await app.inject({
          method: "GET",
          url: "/api/connectors/qq/config"
        })
      ).json();

      const updateConfig = await app.inject({
        method: "PUT",
        url: "/api/connectors/qq/config",
        payload: {
          ...currentConfig,
          platform: "qq",
          enabled: true,
          appId: "app-id-demo",
          appSecret: "app-secret-demo",
          callbackUrl: "http://mock.qq"
        }
      });
      expect(updateConfig.statusCode).toBe(200);

      const callbackPayload = {
        id: "evt-private-1",
        op: 0,
        t: "C2C_MESSAGE_CREATE",
        d: {
          id: "msg-private-1",
          content: "#session:qq-demo fix payment timeout",
          author: {
            user_openid: "uid_private_demo"
          }
        }
      };
      const signedRequest = buildSignedQqWebhookRequest("app-secret-demo", callbackPayload);

      const response = await app.inject({
        method: "POST",
        url: "/api/qq/webhook",
        payload: signedRequest.payload,
        headers: signedRequest.headers
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();
      expect(payload).toMatchObject({
        accepted: true,
        sessionId: "qq-demo",
        riskLevel: "low",
        pendingConfirmation: false,
        notify: {
          sent: true
        }
      });

      const detail = await app.inject({
        method: "GET",
        url: `/api/tasks/${encodeURIComponent(payload.taskId)}/detail`
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().messageTimeline[0].sourcePlatform).toBe("qq");
      expect(qqMock.tokenBodies).toHaveLength(1);
      expect(qqMock.privateBodies).toHaveLength(1);
      const sent = JSON.parse(qqMock.privateBodies[0]) as {
        content: string;
        msg_type: number;
        msg_id: string;
        event_id: string;
      };
      expect(sent.msg_type).toBe(0);
      expect(sent.msg_id).toBe("msg-private-1");
      expect(sent.event_id).toBe("evt-private-1");
      expect(sent.content.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("returns markdown shortcut guide when receiving panel shortcut text", async () => {
    const qqMock = createQqApiV2Mock();
    const app = buildApp({
      env: {
        databasePath: ":memory:",
        logLevel: "silent"
      },
      fetchImpl: qqMock.fetchImpl
    });

    try {
      const currentConfig = (
        await app.inject({
          method: "GET",
          url: "/api/connectors/qq/config"
        })
      ).json();

      const updateConfig = await app.inject({
        method: "PUT",
        url: "/api/connectors/qq/config",
        payload: {
          ...currentConfig,
          platform: "qq",
          enabled: true,
          appId: "app-id-demo",
          appSecret: "app-secret-demo",
          callbackUrl: "http://mock.qq"
        }
      });
      expect(updateConfig.statusCode).toBe(200);

      const callbackPayload = {
        id: "evt-shortcut-1",
        op: 0,
        t: "C2C_MESSAGE_CREATE",
        d: {
          id: "msg-shortcut-1",
          content: "选择项目",
          author: {
            user_openid: "uid_shortcut_demo"
          }
        }
      };
      const signedRequest = buildSignedQqWebhookRequest("app-secret-demo", callbackPayload);

      const response = await app.inject({
        method: "POST",
        url: "/api/qq/webhook",
        payload: signedRequest.payload,
        headers: signedRequest.headers
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        accepted: true,
        shortcutHandled: true,
        shortcut: "选择项目",
        notify: {
          sent: true
        }
      });

      expect(qqMock.privateBodies).toHaveLength(1);
      const outbound = JSON.parse(qqMock.privateBodies[0]) as {
        msg_type: number;
        markdown: { content: string };
        keyboard: { content: { rows: Array<{ buttons: Array<{ action: { type: number } }> }> } };
      };
      expect(outbound.msg_type).toBe(2);
      expect(outbound.markdown.content).toContain("QQ 交互指令说明");
      expect(outbound.keyboard.content.rows.length).toBeGreaterThan(0);
      expect(outbound.keyboard.content.rows[0].buttons[0].action.type).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("falls back to official QQ OpenAPI base when callbackUrl points to localhost webhook path", async () => {
    const qqMock = createQqApiV2Mock();
    const app = buildApp({
      env: {
        databasePath: ":memory:",
        logLevel: "silent"
      },
      fetchImpl: qqMock.fetchImpl
    });

    try {
      const currentConfig = (
        await app.inject({
          method: "GET",
          url: "/api/connectors/qq/config"
        })
      ).json();

      const updateConfig = await app.inject({
        method: "PUT",
        url: "/api/connectors/qq/config",
        payload: {
          ...currentConfig,
          platform: "qq",
          enabled: true,
          appId: "app-id-demo",
          appSecret: "app-secret-demo",
          callbackUrl: "http://127.0.0.1:3000/api/feishu/webhook"
        }
      });
      expect(updateConfig.statusCode).toBe(200);

      const callbackPayload = {
        id: "evt-private-fallback-1",
        op: 0,
        t: "C2C_MESSAGE_CREATE",
        d: {
          id: "msg-private-fallback-1",
          content: "#session:qq-demo-fallback ping",
          author: {
            user_openid: "uid_private_demo_fallback"
          }
        }
      };
      const signedRequest = buildSignedQqWebhookRequest("app-secret-demo", callbackPayload);

      const response = await app.inject({
        method: "POST",
        url: "/api/qq/webhook",
        payload: signedRequest.payload,
        headers: signedRequest.headers
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        accepted: true,
        notify: {
          sent: true
        }
      });

      const qqMessageCall = qqMock.calls.find((call) => call.url.includes("/v2/users/"));
      expect(qqMessageCall?.url).toContain("https://api.sgroup.qq.com/v2/users/");
    } finally {
      await app.close();
    }
  });

  it("accepts GROUP_AT command and routes Codex completion back to QQ group", async () => {
    const qqMock = createQqApiV2Mock();
    const app = buildApp({
      env: {
        databasePath: ":memory:",
        logLevel: "silent"
      },
      fetchImpl: qqMock.fetchImpl
    });

    try {
      const currentConfig = (
        await app.inject({
          method: "GET",
          url: "/api/connectors/qq/config"
        })
      ).json();

      const updateConfig = await app.inject({
        method: "PUT",
        url: "/api/connectors/qq/config",
        payload: {
          ...currentConfig,
          platform: "qq",
          enabled: true,
          appId: "app-id-demo",
          appSecret: "app-secret-demo",
          callbackUrl: "http://mock.qq",
          riskKeywords: ["dropdb", "truncate"]
        }
      });
      expect(updateConfig.statusCode).toBe(200);

      const callbackPayload = {
        id: "evt-group-1",
        op: 0,
        t: "GROUP_AT_MESSAGE_CREATE",
        d: {
          id: "msg-group-1",
          content: "<@!10001> #session:qq-finish add unit tests",
          group_openid: "group_openid_demo",
          author: {
            member_openid: "uid_group_demo"
          }
        }
      };
      const signedRequest = buildSignedQqWebhookRequest("app-secret-demo", callbackPayload);

      const incoming = await app.inject({
        method: "POST",
        url: "/api/qq/webhook",
        payload: signedRequest.payload,
        headers: signedRequest.headers
      });
      expect(incoming.statusCode).toBe(200);
      const taskId = incoming.json().taskId as string;

      const codexEvent = await app.inject({
        method: "POST",
        url: "/api/codex/events",
        payload: {
          eventId: "qq-codex-done-1",
          taskId,
          sessionId: "qq-finish",
          status: "succeeded",
          summary: "tests completed"
        }
      });
      expect(codexEvent.statusCode).toBe(200);
      expect(codexEvent.json()).toMatchObject({
        accepted: true,
        status: "succeeded",
        notify: {
          sent: true
        }
      });

      expect(qqMock.groupBodies.length).toBeGreaterThanOrEqual(2);
      const firstGroupMessage = JSON.parse(qqMock.groupBodies[0]) as { msg_id: string; event_id: string };
      expect(firstGroupMessage.msg_id).toBe("msg-group-1");
      expect(firstGroupMessage.event_id).toBe("evt-group-1");

      const last = JSON.parse(qqMock.groupBodies.at(-1) || "{}") as { content: string };
      expect(last.content.length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("handles INTERACTION_CREATE and forwards structured command to existing task flow", async () => {
    const qqMock = createQqApiV2Mock();
    const app = buildApp({
      env: {
        databasePath: ":memory:",
        logLevel: "silent"
      },
      fetchImpl: qqMock.fetchImpl
    });

    try {
      const currentConfig = (
        await app.inject({
          method: "GET",
          url: "/api/connectors/qq/config"
        })
      ).json();

      const updateConfig = await app.inject({
        method: "PUT",
        url: "/api/connectors/qq/config",
        payload: {
          ...currentConfig,
          platform: "qq",
          enabled: true,
          appId: "app-id-demo",
          appSecret: "app-secret-demo",
          callbackUrl: "http://mock.qq"
        }
      });
      expect(updateConfig.statusCode).toBe(200);

      const callbackPayload = {
        id: "evt-interaction-1",
        op: 0,
        t: "INTERACTION_CREATE",
        d: {
          id: "interaction-1",
          user_openid: "uid_interaction_demo",
          data: {
            resolved: {
              message_id: "origin-msg-1",
              button_data: JSON.stringify({
                action: "dispatch",
                sessionId: "qq-interaction-session",
                prompt: "fix login timeout and add tests"
              })
            }
          }
        }
      };
      const signedRequest = buildSignedQqWebhookRequest("app-secret-demo", callbackPayload);

      const response = await app.inject({
        method: "POST",
        url: "/api/qq/webhook",
        payload: signedRequest.payload,
        headers: signedRequest.headers
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        accepted: true,
        interactionHandled: true,
        command: "#session:qq-interaction-session fix login timeout and add tests",
        result: {
          accepted: true,
          sessionId: "qq-interaction-session"
        },
        acknowledge: {
          sent: true
        }
      });

      expect(qqMock.privateBodies.length).toBeGreaterThanOrEqual(1);
      const outbound = JSON.parse(qqMock.privateBodies[0]) as { msg_type: number; msg_id: string; event_id: string };
      expect(outbound.msg_type).toBe(0);
      expect(outbound.msg_id).toBe("origin-msg-1");
      expect(outbound.event_id).toBe("evt-interaction-1");

      expect(qqMock.interactionBodies).toHaveLength(1);
      expect(JSON.parse(qqMock.interactionBodies[0])).toMatchObject({
        code: 0
      });
    } finally {
      await app.close();
    }
  });

  it("handles INTERACTION_CREATE shortcut command with markdown help + keyboard", async () => {
    const qqMock = createQqApiV2Mock();
    const app = buildApp({
      env: {
        databasePath: ":memory:",
        logLevel: "silent"
      },
      fetchImpl: qqMock.fetchImpl
    });

    try {
      const currentConfig = (
        await app.inject({
          method: "GET",
          url: "/api/connectors/qq/config"
        })
      ).json();

      const updateConfig = await app.inject({
        method: "PUT",
        url: "/api/connectors/qq/config",
        payload: {
          ...currentConfig,
          platform: "qq",
          enabled: true,
          appId: "app-id-demo",
          appSecret: "app-secret-demo",
          callbackUrl: "http://mock.qq"
        }
      });
      expect(updateConfig.statusCode).toBe(200);

      const callbackPayload = {
        id: "evt-interaction-2",
        op: 0,
        t: "INTERACTION_CREATE",
        d: {
          id: "interaction-2",
          group_openid: "group-openid-2",
          group_member_openid: "uid_group_interaction_demo",
          data: {
            resolved: {
              message_id: "origin-msg-2",
              button_data: "查看项目"
            }
          }
        }
      };
      const signedRequest = buildSignedQqWebhookRequest("app-secret-demo", callbackPayload);

      const response = await app.inject({
        method: "POST",
        url: "/api/qq/webhook",
        payload: signedRequest.payload,
        headers: signedRequest.headers
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        accepted: true,
        interactionHandled: true,
        reason: "shortcut_command",
        notify: {
          sent: true
        },
        acknowledge: {
          sent: true
        }
      });

      expect(qqMock.groupBodies).toHaveLength(1);
      const outbound = JSON.parse(qqMock.groupBodies[0]) as {
        msg_type: number;
        markdown: { content: string };
        keyboard: { content: { rows: Array<{ buttons: Array<{ action: { type: number; data: string } }> }> } };
      };
      expect(outbound.msg_type).toBe(2);
      expect(outbound.markdown.content).toContain("QQ 交互指令说明");
      expect(outbound.keyboard.content.rows.length).toBeGreaterThan(0);
      expect(outbound.keyboard.content.rows[0].buttons[0].action.type).toBe(1);

      expect(qqMock.interactionBodies).toHaveLength(1);
      expect(JSON.parse(qqMock.interactionBodies[0])).toMatchObject({
        code: 0
      });
    } finally {
      await app.close();
    }
  });
});
