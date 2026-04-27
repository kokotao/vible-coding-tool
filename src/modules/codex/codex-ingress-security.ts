/**
 * @description Codex 入站鉴权工具，支持 token 校验、HMAC 签名和重放防护
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-26 22:36
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "../../lib/errors";
import { IdempotencyRepository } from "../../storage/repositories/idempotency-repository";

type CodexIngressHeaders = Record<string, unknown>;

export type CodexIngressSecurityOptions = {
  ingressToken?: string;
  signingSecret?: string;
  maxSkewSeconds: number;
};

export type CodexIngressVerifyInput = {
  headers: CodexIngressHeaders;
  payload: unknown;
  options: CodexIngressSecurityOptions;
  idempotencyRepository: IdempotencyRepository;
  now?: Date;
};

export function verifyCodexIngress(input: CodexIngressVerifyInput) {
  verifyIngressToken(input.options.ingressToken, input.headers["x-codex-ingress-token"] as string | undefined);

  if (!input.options.signingSecret) {
    return;
  }

  const timestamp = String(input.headers["x-codex-ingress-timestamp"] ?? "");
  const nonce = String(input.headers["x-codex-ingress-nonce"] ?? "");
  const signatureRaw = String(input.headers["x-codex-ingress-signature"] ?? "");

  if (!timestamp || !signatureRaw) {
    throw new AppError("CODEX_SIGNATURE_MISSING", 401, "Codex ingress signature headers are missing");
  }

  const timestampSec = Number(timestamp);
  if (!Number.isFinite(timestampSec)) {
    throw new AppError("CODEX_SIGNATURE_INVALID", 401, "Codex ingress timestamp is invalid");
  }

  const now = input.now ?? new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  if (Math.abs(nowSec - timestampSec) > input.options.maxSkewSeconds) {
    throw new AppError("CODEX_SIGNATURE_EXPIRED", 401, "Codex ingress signature timestamp expired");
  }

  const normalizedSignature = normalizeSignature(signatureRaw);
  const payloadString = JSON.stringify(input.payload ?? null);
  const signingText = `${timestamp}.${nonce}.${payloadString}`;
  const expectedSignature = createHmac("sha256", input.options.signingSecret).update(signingText).digest("hex");

  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  const receivedBuffer = Buffer.from(normalizedSignature, "utf8");
  if (expectedBuffer.length !== receivedBuffer.length || !timingSafeEqual(expectedBuffer, receivedBuffer)) {
    throw new AppError("CODEX_SIGNATURE_INVALID", 401, "Codex ingress signature verification failed");
  }

  const replayKey = `codex:sign:${timestamp}:${nonce}:${normalizedSignature}`;
  const accepted = input.idempotencyRepository.saveIfAbsent({
    idempotencyKey: replayKey,
    scope: "codex_ingress_signature",
    createdAt: now.toISOString()
  });

  if (!accepted) {
    throw new AppError("CODEX_SIGNATURE_REPLAYED", 401, "Codex ingress signature replay detected");
  }
}

function verifyIngressToken(expected: string | undefined, received: string | undefined) {
  if (!expected) {
    return;
  }

  if (expected !== received) {
    throw new AppError("CODEX_TOKEN_INVALID", 401, "Codex ingress token mismatch");
  }
}

function normalizeSignature(signature: string) {
  if (signature.startsWith("sha256=")) {
    return signature.slice("sha256=".length);
  }

  return signature;
}
