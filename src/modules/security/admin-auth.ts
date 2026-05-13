/**
 * @description 后台管理接口鉴权模块，统一校验本地控制台意图头与可选管理员令牌
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-05-10 14:05
 */
import type { FastifyRequest } from "fastify";
import { AppError } from "../../lib/errors";

export const ADMIN_INTENT_HEADER = "x-viblect-admin-intent";
export const ADMIN_TOKEN_HEADER = "x-viblect-admin-token";
export const ADMIN_INTENT_VALUE = "web-console";

export type AdminAccessOptions = {
  adminToken?: string;
};

export function verifyAdminAccess(request: FastifyRequest, options: AdminAccessOptions) {
  const configuredToken = String(options.adminToken || "").trim();

  if (!configuredToken && process.env.NODE_ENV === "test") {
    return;
  }

  const intent = readHeader(request, ADMIN_INTENT_HEADER);
  if (intent !== ADMIN_INTENT_VALUE) {
    throw new AppError("ADMIN_INTENT_REQUIRED", 401, "Admin intent header is required");
  }

  if (configuredToken) {
    const providedToken = readHeader(request, ADMIN_TOKEN_HEADER);
    if (providedToken !== configuredToken) {
      throw new AppError("ADMIN_TOKEN_INVALID", 401, "Admin token is invalid");
    }
    return;
  }

  if (!isLoopbackRequest(request)) {
    throw new AppError("ADMIN_LOCAL_ONLY", 403, "Admin API is restricted to local access");
  }
}

function readHeader(request: FastifyRequest, name: string) {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return String(value[0] || "").trim();
  }
  return String(value || "").trim();
}

function isLoopbackRequest(request: FastifyRequest) {
  const candidates = [String(request.ip || "").trim(), String(request.socket?.remoteAddress || "").trim()].filter(Boolean);

  return candidates.some((value) => {
    const normalized = normalizeIp(value);
    return normalized === "127.0.0.1" || normalized === "::1";
  });
}

function normalizeIp(value: string) {
  const text = value.trim();
  if (text.startsWith("::ffff:")) {
    return text.slice("::ffff:".length);
  }
  return text;
}
