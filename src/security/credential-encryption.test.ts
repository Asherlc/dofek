import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decryptCredentialValue,
  deriveCredentialIdentifier,
  encryptCredentialValue,
  isEncryptedCredentialValue,
} from "./credential-encryption.ts";

describe("credential encryption", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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

  it("derives a stable secret-keyed identifier bound to its storage context", () => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY_BASE64", Buffer.alloc(32, 7).toString("base64"));
    const context = {
      tableName: "fitness.oauth_token",
      columnName: "provider_account_id",
      scopeId: "user-a:ziva",
    };

    const first = deriveCredentialIdentifier("provider-account-a", context);
    const repeated = deriveCredentialIdentifier("provider-account-a", context);
    const otherAccount = deriveCredentialIdentifier("provider-account-b", context);
    const otherUser = deriveCredentialIdentifier("provider-account-a", {
      ...context,
      scopeId: "user-b:ziva",
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toBe("74bc6238328e776518ab55351cfed22732f403e93aa2143213e4dab8f0d7cff0");
    expect(repeated).toBe(first);
    expect(otherAccount).not.toBe(first);
    expect(otherUser).not.toBe(first);
    expect(first).not.toContain("provider-account-a");

    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY_BASE64", Buffer.alloc(32, 9).toString("base64"));
    expect(deriveCredentialIdentifier("provider-account-a", context)).not.toBe(first);
  });

  it("encodes identifier inputs without cross-field ambiguity", () => {
    const baseContext = {
      tableName: "fitness.oauth_token",
      columnName: "provider_account_id",
    };

    const first = deriveCredentialIdentifier("c", {
      ...baseContext,
      scopeId: "a\0b",
    });
    const boundaryShifted = deriveCredentialIdentifier("b\0c", {
      ...baseContext,
      scopeId: "a",
    });

    expect(boundaryShifted).not.toBe(first);
  });
});
