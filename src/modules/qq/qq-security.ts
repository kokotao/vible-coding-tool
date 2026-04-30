import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function buildSeed(secret: string) {
  const bytes = Buffer.from(secret, "utf8");
  const seed = Buffer.alloc(32, 0);
  if (bytes.length === 0) {
    return seed;
  }
  for (let i = 0; i < seed.length; i += 1) {
    seed[i] = bytes[i % bytes.length];
  }
  return seed;
}

function buildPrivateKey(secret: string): KeyObject {
  const seed = buildSeed(secret);
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  return createPrivateKey({
    key: der,
    type: "pkcs8",
    format: "der"
  });
}

export function createQqValidationSignature(input: { secret: string; eventTs: string; plainToken: string }) {
  const message = Buffer.from(`${input.eventTs}${input.plainToken}`);
  const privateKey = buildPrivateKey(input.secret);
  const signature = sign(null, message, privateKey);
  return signature.toString("hex");
}

export function createQqRequestSignature(input: { secret: string; timestamp: string; rawBody: string }) {
  const message = Buffer.from(`${input.timestamp}${input.rawBody}`);
  const privateKey = buildPrivateKey(input.secret);
  const signature = sign(null, message, privateKey);
  return signature.toString("hex");
}

export function verifyQqEventSignature(input: {
  secret: string;
  timestamp: string;
  signature: string;
  rawBody: string;
}) {
  if (!input.secret || !input.timestamp || !input.signature || !input.rawBody) {
    return false;
  }

  try {
    const privateKey = buildPrivateKey(input.secret);
    const publicKey = createPublicKey(privateKey);
    return verify(
      null,
      Buffer.from(`${input.timestamp}${input.rawBody}`),
      publicKey,
      Buffer.from(input.signature, "hex")
    );
  } catch {
    return false;
  }
}
