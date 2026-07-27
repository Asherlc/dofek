import { createHmac, hkdfSync } from "node:crypto";
import { z } from "zod";

const accountErasureLedgerKeyIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const encodedKeySchema = z.string().min(1);
const accountErasureLedgerKeyringSchema = z.object({
  activeKeyId: accountErasureLedgerKeyIdSchema,
  keys: z.record(accountErasureLedgerKeyIdSchema, encodedKeySchema),
});

export interface AccountErasureUserIdentity {
  keyId: string;
  userHash: string;
}

export type AccountErasureExternalIdentity =
  | {
      authProvider: string;
      kind: "provider_account";
      providerAccountId: string;
    }
  | {
      email: string;
      kind: "email";
    };

export interface AccountErasureExternalIdentityHash {
  identityHash: string;
  identityKind: AccountErasureExternalIdentity["kind"];
  keyId: string;
}

export interface AccountErasureLedgerKeyring {
  activeKeyId: string;
  keys: Readonly<Record<string, string>>;
}

export function readAccountErasureLedgerKeyring(
  serializedKeyring = process.env.ACCOUNT_ERASURE_LEDGER_KEYRING_JSON,
): AccountErasureLedgerKeyring {
  if (!serializedKeyring) {
    throw new Error("ACCOUNT_ERASURE_LEDGER_KEYRING_JSON is required for account erasure");
  }
  const parsedJson: unknown = JSON.parse(serializedKeyring);
  const keyring = accountErasureLedgerKeyringSchema.parse(parsedJson);
  if (!(keyring.activeKeyId in keyring.keys)) {
    throw new Error("ACCOUNT_ERASURE_LEDGER_KEYRING_JSON activeKeyId has no matching key");
  }
  return keyring;
}

function decodeAccountErasureLedgerMasterKey(
  keyId: string,
  keyring: AccountErasureLedgerKeyring = readAccountErasureLedgerKeyring(),
): Buffer {
  const encodedKey = keyring.keys[keyId];
  if (!encodedKey) {
    throw new Error(`Account erasure ledger keyring is missing key ${keyId}`);
  }
  const key = Buffer.from(encodedKey, "base64");
  if (key.byteLength !== 32) {
    throw new Error(`Account erasure ledger master key ${keyId} must decode to exactly 32 bytes`);
  }
  return key;
}

export function validateAccountErasureLedgerKeyring(
  serializedKeyring = process.env.ACCOUNT_ERASURE_LEDGER_KEYRING_JSON,
): AccountErasureLedgerKeyring {
  const keyring = readAccountErasureLedgerKeyring(serializedKeyring);
  for (const keyId of Object.keys(keyring.keys)) {
    decodeAccountErasureLedgerMasterKey(keyId, keyring);
  }
  return keyring;
}

function deriveAccountErasureLedgerKey(
  keyId: string,
  purpose: "identity-hmac" | "status-token-encryption",
  keyring?: AccountErasureLedgerKeyring,
): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      decodeAccountErasureLedgerMasterKey(keyId, keyring),
      Buffer.from("dofek-account-erasure-ledger-v1"),
      Buffer.from(`dofek-account-erasure-ledger-v1/${purpose}`),
      32,
    ),
  );
}

export function deriveAccountErasureLedgerEncryptionKey(
  keyId: string,
  keyring?: AccountErasureLedgerKeyring,
): Buffer {
  return deriveAccountErasureLedgerKey(keyId, "status-token-encryption", keyring);
}

function hashUserId(userId: string, keyId: string, encodedKey: string): AccountErasureUserIdentity {
  const key = deriveAccountErasureLedgerKey(keyId, "identity-hmac", {
    activeKeyId: keyId,
    keys: { [keyId]: encodedKey },
  });
  return {
    keyId,
    userHash: createHmac("sha256", key).update(userId).digest("hex"),
  };
}

function externalIdentityValue(identity: AccountErasureExternalIdentity): string {
  if (identity.kind === "email") {
    return `email:${z
      .string()
      .email()
      .parse(identity.email.trim().normalize("NFKC").toLowerCase())}`;
  }
  const authProvider = z.string().trim().min(1).parse(identity.authProvider).toLowerCase();
  const providerAccountId = z.string().trim().min(1).parse(identity.providerAccountId);
  return `provider_account:${authProvider}:${providerAccountId}`;
}

export function createAccountErasureExternalIdentityHashes(
  identity: AccountErasureExternalIdentity,
  keyring: AccountErasureLedgerKeyring = readAccountErasureLedgerKeyring(),
): AccountErasureExternalIdentityHash[] {
  const value = externalIdentityValue(identity);
  return Object.entries(keyring.keys)
    .map(([keyId, encodedKey]) => {
      const key = deriveAccountErasureLedgerKey(keyId, "identity-hmac", {
        activeKeyId: keyId,
        keys: { [keyId]: encodedKey },
      });
      return {
        identityHash: createHmac("sha256", key).update(value).digest("hex"),
        identityKind: identity.kind,
        keyId,
      };
    })
    .sort((left, right) => left.keyId.localeCompare(right.keyId));
}

export function createAccountErasureUserIdentity(
  userId: string,
  keyring: AccountErasureLedgerKeyring = readAccountErasureLedgerKeyring(),
): AccountErasureUserIdentity {
  const encodedKey = keyring.keys[keyring.activeKeyId];
  if (!encodedKey) {
    throw new Error(`Account erasure ledger keyring is missing active key ${keyring.activeKeyId}`);
  }
  return hashUserId(userId, keyring.activeKeyId, encodedKey);
}

export function createAccountErasureUserIdentities(
  userId: string,
  keyring: AccountErasureLedgerKeyring = readAccountErasureLedgerKeyring(),
): AccountErasureUserIdentity[] {
  return Object.entries(keyring.keys)
    .map(([keyId, encodedKey]) => hashUserId(userId, keyId, encodedKey))
    .sort((left, right) => left.keyId.localeCompare(right.keyId));
}

export function createAccountErasureUserHash(
  userId: string,
  keyring?: AccountErasureLedgerKeyring,
): string {
  return createAccountErasureUserIdentity(userId, keyring).userHash;
}
