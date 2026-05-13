import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { AppError } from "../../src/lib/errors";
import { ADMIN_INTENT_HEADER, ADMIN_INTENT_VALUE, verifyAdminAccess } from "../../src/modules/security/admin-auth";

describe("admin auth", () => {
  it("rejects spoofed forwarded loopback address when admin token is not configured", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    try {
      const request = {
        headers: {
          [ADMIN_INTENT_HEADER]: ADMIN_INTENT_VALUE,
          "x-forwarded-for": "127.0.0.1"
        },
        ip: "10.0.0.8",
        socket: {
          remoteAddress: "10.0.0.8"
        }
      } as unknown as FastifyRequest;

      expect(() => verifyAdminAccess(request, {})).toThrowError(AppError);
      expect(() => verifyAdminAccess(request, {})).toThrow(/restricted to local access/i);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("allows real loopback access without admin token", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    try {
      const request = {
        headers: {
          [ADMIN_INTENT_HEADER]: ADMIN_INTENT_VALUE
        },
        ip: "127.0.0.1",
        socket: {
          remoteAddress: "127.0.0.1"
        }
      } as unknown as FastifyRequest;

      expect(() => verifyAdminAccess(request, {})).not.toThrow();
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });
});
