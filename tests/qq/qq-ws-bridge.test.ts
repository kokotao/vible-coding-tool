import { resolveQqWsBridgeDefaults, startQqWsBridge } from "../../src/modules/qq/qq-ws-bridge";
import { createQqRequestSignature } from "../../src/modules/qq/qq-security";
import { createFetchMock } from "../helpers/fetch-mock";
import { createAdminHeaders } from "../helpers/admin-auth";

class FakeWebSocket {
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | Buffer | Uint8Array | ArrayBuffer }) => void) | null = null;
  onerror: ((event: { error?: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;

  constructor(public readonly url: string) {}

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  emitMessage(payload: unknown) {
    this.onmessage?.({
      data: JSON.stringify(payload)
    });
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function waitForMicrotasks() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("qq websocket bridge", () => {
  it("skips startup when qq connector mode is not websocket", async () => {
    const { fetchImpl } = createFetchMock([
      {
        match: /\/health$/,
        response: () => new Response(JSON.stringify({ ok: true }), { status: 200 })
      },
      {
        match: /\/api\/connectors\/qq\/runtime-config$/,
        response: () =>
          new Response(JSON.stringify({ appId: "qq-app", appSecret: "qq-secret", eventMode: "webhook" }), {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          })
      }
    ]);

    const handle = await startQqWsBridge({
      gatewayUrl: "http://mock.gateway",
      fetchImpl,
      gatewayHeaders: createAdminHeaders()
    });
    try {
      expect(handle.active).toBe(false);
    } finally {
      await handle.stop();
    }
  });

  it("connects gateway and forwards dispatch events into /api/qq/webhook with signature", async () => {
    const forwardedBodies: string[] = [];
    const forwardedHeaders: Array<Record<string, string>> = [];
    const sockets: FakeWebSocket[] = [];

    const { fetchImpl } = createFetchMock([
      {
        match: /\/health$/,
        response: () => new Response(JSON.stringify({ ok: true }), { status: 200 })
      },
      {
        match: /\/api\/connectors\/qq\/runtime-config$/,
        response: () =>
          new Response(
            JSON.stringify({
              appId: "qq-app",
              appSecret: "qq-secret",
              eventMode: "websocket",
              callbackUrl: ""
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
        match: "https://bots.qq.com/app/getAppAccessToken",
        response: () =>
          new Response(
            JSON.stringify({
              access_token: "qq-token-001",
              expires_in: 7200
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
        match: "https://api.sgroup.qq.com/gateway",
        response: () =>
          new Response(
            JSON.stringify({
              url: "wss://gateway.mock.qq/ws"
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
        match: /\/api\/qq\/webhook$/,
        response: ({ bodyText, init }) => {
          forwardedBodies.push(bodyText);
          forwardedHeaders.push((init?.headers as Record<string, string>) || {});
          return new Response(JSON.stringify({ accepted: true }), {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          });
        }
      }
    ]);

    const handle = await startQqWsBridge({
      gatewayUrl: "http://mock.gateway",
      fetchImpl,
      gatewayHeaders: createAdminHeaders(),
      websocketFactory: (url) => {
        const ws = new FakeWebSocket(url);
        sockets.push(ws);
        return ws;
      }
    });

    try {
      expect(handle.active).toBe(true);
      expect(sockets).toHaveLength(1);

      const socket = sockets[0];
      socket.open();
      socket.emitMessage({
        op: 10,
        d: {
          heartbeat_interval: 30000
        }
      });
      await waitForMicrotasks();

      const identify = JSON.parse(socket.sent[0]) as { op: number; d: { intents: number; token: string } };
      expect(identify.op).toBe(2);
      expect(identify.d.token).toBe("QQBot qq-token-001");
      expect(identify.d.intents).toBeGreaterThan(0);

      const eventPayload = {
        id: "evt-001",
        op: 0,
        t: "C2C_MESSAGE_CREATE",
        s: 99,
        d: {
          id: "msg-001",
          content: "#session:qq-demo hello",
          author: {
            user_openid: "uid-001"
          }
        }
      };
      socket.emitMessage(eventPayload);
      await waitForMicrotasks();

      expect(forwardedBodies).toHaveLength(1);
      expect(JSON.parse(forwardedBodies[0])).toMatchObject({
        t: "C2C_MESSAGE_CREATE",
        id: "evt-001"
      });

      const timestamp = forwardedHeaders[0]["x-signature-timestamp"];
      const signature = forwardedHeaders[0]["x-signature-ed25519"];
      expect(timestamp).toBeTruthy();
      expect(signature).toBeTruthy();
      expect(signature).toBe(
        createQqRequestSignature({
          secret: "qq-secret",
          timestamp,
          rawBody: forwardedBodies[0]
        })
      );
    } finally {
      await handle.stop();
    }
  });

  it("defaults to auto start outside test env", () => {
    expect(resolveQqWsBridgeDefaults().autoStart).toBe(false);
  });

  it("throws when runtime config omits qq secret", async () => {
    const { fetchImpl } = createFetchMock([
      {
        match: /\/health$/,
        response: () => new Response(JSON.stringify({ ok: true }), { status: 200 })
      },
      {
        match: /\/api\/connectors\/qq\/runtime-config$/,
        response: () =>
          new Response(JSON.stringify({ appId: "qq-app", eventMode: "websocket", appSecretConfigured: true }), {
            status: 200,
            headers: {
              "content-type": "application/json"
            }
          })
      }
    ]);

    await expect(
      startQqWsBridge({
        gatewayUrl: "http://mock.gateway",
        fetchImpl,
        gatewayHeaders: createAdminHeaders()
      })
    ).rejects.toThrow("missing qq appId/appSecret in connector config");
  });
});
