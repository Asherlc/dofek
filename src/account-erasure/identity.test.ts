import { describe, expect, it } from "vitest";
import {
  createAccountErasureExternalIdentityHashes,
  createAccountErasureUserHash,
  createAccountErasureUserIdentities,
  validateAccountErasureLedgerKeyring,
} from "./identity.ts";

describe("createAccountErasureUserHash", () => {
  it("is stable for restore reconciliation and keyed per deployment", () => {
    const firstKeyring = {
      activeKeyId: "2026-07",
      keys: { "2026-07": Buffer.alloc(32, 1).toString("base64") },
    };
    const secondKeyring = {
      activeKeyId: "2026-08",
      keys: { "2026-08": Buffer.alloc(32, 2).toString("base64") },
    };

    expect(createAccountErasureUserHash("user-1", firstKeyring)).toBe(
      createAccountErasureUserHash("user-1", firstKeyring),
    );
    expect(createAccountErasureUserHash("user-1", firstKeyring)).not.toBe(
      createAccountErasureUserHash("user-1", secondKeyring),
    );
    expect(createAccountErasureUserHash("user-1", firstKeyring)).not.toBe(
      createAccountErasureUserHash("user-2", firstKeyring),
    );
  });

  it("retains old key identities so restore reconciliation survives rotation", () => {
    const identities = createAccountErasureUserIdentities("user-1", {
      activeKeyId: "new",
      keys: {
        old: Buffer.alloc(32, 1).toString("base64"),
        new: Buffer.alloc(32, 2).toString("base64"),
      },
    });

    expect(identities.map((identity) => identity.keyId)).toEqual(["new", "old"]);
    expect(new Set(identities.map((identity) => identity.userHash)).size).toBe(2);
  });

  it("fails startup validation when any retained rotation key is malformed", () => {
    expect(() =>
      validateAccountErasureLedgerKeyring(
        JSON.stringify({
          activeKeyId: "new",
          keys: {
            old: Buffer.alloc(31, 1).toString("base64"),
            new: Buffer.alloc(32, 2).toString("base64"),
          },
        }),
      ),
    ).toThrow("old must decode to exactly 32 bytes");
  });

  it("normalizes email and provider names while retaining every rotation key", () => {
    const keyring = {
      activeKeyId: "new",
      keys: {
        old: Buffer.alloc(32, 1).toString("base64"),
        new: Buffer.alloc(32, 2).toString("base64"),
      },
    };

    expect(
      createAccountErasureExternalIdentityHashes(
        { email: " User@Example.Test ", kind: "email" },
        keyring,
      ),
    ).toEqual(
      createAccountErasureExternalIdentityHashes(
        { email: "user@example.test", kind: "email" },
        keyring,
      ),
    );
    expect(
      createAccountErasureExternalIdentityHashes(
        {
          authProvider: "Google",
          kind: "provider_account",
          providerAccountId: "Case-Sensitive-ID",
        },
        keyring,
      ),
    ).toEqual(
      createAccountErasureExternalIdentityHashes(
        {
          authProvider: "google",
          kind: "provider_account",
          providerAccountId: "Case-Sensitive-ID",
        },
        keyring,
      ),
    );
    expect(
      createAccountErasureExternalIdentityHashes(
        { email: "user@example.test", kind: "email" },
        keyring,
      ).map((identity) => identity.keyId),
    ).toEqual(["new", "old"]);
  });
});
