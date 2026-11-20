import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config/env";

const key = Buffer.from(env.PII_ENCRYPTION_KEY, "hex");
const version = "v1";

export function encryptPii(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    version,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function decryptPii(value: string): string {
  const [encodedVersion, encodedIv, encodedTag, encodedCiphertext, extra] =
    value.split(":");
  if (
    encodedVersion !== version ||
    !encodedIv ||
    !encodedTag ||
    encodedCiphertext === undefined ||
    extra !== undefined
  ) {
    throw new Error("Encrypted PII value is malformed");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(encodedIv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}