import { buildApp } from "../../src/app";

describe("buildApp", () => {
  it("returns health payload", async () => {
    const app = buildApp({
      env: {
        databasePath: ":memory:",
        logLevel: "silent"
      }
    });

    const response = await app.inject({
      method: "GET",
      url: "/health"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    await app.close();
  });
});
