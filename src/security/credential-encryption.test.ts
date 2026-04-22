import { describe, expect, it } from "vitest";
import {
  decryptCredentialValue,
  encryptCredentialValue,
  isEncryptedCredentialValue,
} from "./credential-encryption.ts";

describe("credential encryption", () => {
  it("encrypts and decrypts values with context", async () => {
    const context = {
      tableName: "fitness.oauth_token",
      columnName: "access_token",
      scopeId: "wahoo",
    };

    const plaintext = "secret-access-token";
    const encrypted = await encryptCredentialValue(plaintext, context);

    expect(encrypted).not.toBe(plaintext);
    expect(isEncryptedCredentialValue(encrypted)).toBe(true);

    const decrypted = await decryptCredentialValue(encrypted, context);
    expect(decrypted).toBe(plaintext);
  });

  it("passes through plaintext values for backwards compatibility", async () => {
    const plaintext = "legacy-plaintext-token";
    const decrypted = await decryptCredentialValue(plaintext, {
      tableName: "fitness.oauth_token",
      columnName: "access_token",
      scopeId: "legacy",
    });

    expect(decrypted).toBe(plaintext);
    expect(isEncryptedCredentialValue(plaintext)).toBe(false);
  });
});
