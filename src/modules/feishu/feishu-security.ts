/**
 * @description 飞书 webhook 安全工具，处理签名校验与加密 payload 解密
 * @author Albert_Luo
 * @email 480199976@qq.com
 * @date 2026-04-26 09:35
 */
import { createHash } from "node:crypto";
import { AESCipher } from "@larksuiteoapi/node-sdk";
import { AppError } from "../../lib/errors";

type FeishuHeaders = Record<string, unknown>;

export function verifyFeishuEventSignature(
  encryptKey: string | undefined,
  headers: FeishuHeaders,
  payload: unknown
) {
  if (!encryptKey) {
    return;
  }

  const timestamp = String(headers["x-lark-request-timestamp"] ?? "");
  const nonce = String(headers["x-lark-request-nonce"] ?? "");
  const signature = String(headers["x-lark-signature"] ?? "");

  if (!timestamp || !nonce || !signature) {
    throw new AppError("FEISHU_SIGNATURE_MISSING", 401, "Feishu signature headers are missing");
  }

  const expected = createHash("sha256")
    .update(timestamp + nonce + encryptKey + JSON.stringify(payload))
    .digest("hex");

  if (expected !== signature) {
    throw new AppError("FEISHU_SIGNATURE_INVALID", 401, "Feishu signature verification failed");
  }
}

export function decryptFeishuPayloadIfNeeded(payload: unknown, encryptKey: string | undefined) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  if (!("encrypt" in payload)) {
    return payload;
  }

  if (!encryptKey) {
    throw new AppError("FEISHU_ENCRYPT_KEY_MISSING", 400, "Encrypt payload received but FEISHU_ENCRYPT_KEY is not configured");
  }

  const typedPayload = payload as { encrypt?: unknown };
  if (typeof typedPayload.encrypt !== "string") {
    throw new AppError("FEISHU_ENCRYPT_PAYLOAD_INVALID", 400, "Encrypt payload is invalid");
  }

  try {
    const cipher = new AESCipher(encryptKey);
    const decrypted = JSON.parse(cipher.decrypt(typedPayload.encrypt)) as Record<string, unknown>;
    const { encrypt: _encrypt, ...rest } = typedPayload as Record<string, unknown>;
    return {
      ...decrypted,
      ...rest
    };
  } catch {
    throw new AppError("FEISHU_DECRYPT_FAILED", 400, "Failed to decrypt Feishu payload");
  }
}
