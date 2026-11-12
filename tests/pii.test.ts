import { describe, expect, it } from "vitest";
import { decryptPii, encryptPii } from "../src/shared/crypto/pii";

describe("PII encryption", () => {
  it("round-trips values using authenticated encryption", () => {
    const encrypted = encryptPii("2009-03-14");
    expect(encrypted).not.toContain("2009-03-14");
    expect(decryptPii(encrypted)).toBe("2009-03-14");
  });

  it("rejects values whose authentication tag is changed", () => {
    const encrypted = encryptPii("+233201234567");
    const parts = encrypted.split(":");
    const tag = Buffer.from(parts[2]!, "base64url");
    tag[0] = tag[0]! ^ 1;
    parts[2] = tag.toString("base64url");
    expect(() => decryptPii(parts.join(":"))).toThrow();
  });
});