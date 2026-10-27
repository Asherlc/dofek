import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { deriveAccountErasureLedgerEncryptionKey } from "./identity.ts";

const keyIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const statusTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const userHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const AUTH_TAG_LENGTH = 16;

const restoreIntentSchema = z.strictObject({
  keyId: keyIdSchema,
  requestId: z.uuid(),
  requestedAt: z.iso.datetime(),
  statusToken: statusTokenSchema,
  userHash: userHashSchema,
});

const sealedRestoreIntentSchema = z.strictObject({
  encryptedStatusToken: z.string().min(1),
  initializationVector: z.string().min(1),
  keyId: keyIdSchema,
  requestId: z.uuid(),
  requestedAt: z.iso.datetime(),
  statusTokenAuthTag: z.string().min(1),
  userHash: userHashSchema,
  version: z.literal(1),
});

export type AccountErasureRestoreIntent = z.infer<typeof restoreIntentSchema>;
export type SealedAccountErasureRestoreIntent = z.infer<typeof sealedRestoreIntentSchema>;

function additionalData(
  intent: Pick<AccountErasureRestoreIntent, "keyId" | "requestId" | "requestedAt" | "userHash">,
): Buffer {
  return Buffer.from(
    [
      "dofek-account-erasure-status-token-v1",
      intent.keyId,
      intent.requestId,
      intent.requestedAt,
      intent.userHash,
    ].join("\0"),
  );
}

export function sealAccountErasureRestoreIntent(
  value: AccountErasureRestoreIntent,
): SealedAccountErasureRestoreIntent {
  const intent = restoreIntentSchema.parse(value);
  const initializationVector = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    deriveAccountErasureLedgerEncryptionKey(intent.keyId),
    initializationVector,
    { authTagLength: AUTH_TAG_LENGTH },
  );
  cipher.setAAD(additionalData(intent));
  const encryptedStatusToken = Buffer.concat([
    cipher.update(intent.statusToken, "utf8"),
    cipher.final(),
  ]);
  return {
    encryptedStatusToken: encryptedStatusToken.toString("base64"),
    initializationVector: initializationVector.toString("base64"),
    keyId: intent.keyId,
    requestId: intent.requestId,
    requestedAt: intent.requestedAt,
    statusTokenAuthTag: cipher.getAuthTag().toString("base64"),
    userHash: intent.userHash,
    version: 1,
  };
}

export function openAccountErasureRestoreIntent(value: unknown): AccountErasureRestoreIntent {
  const sealed = sealedRestoreIntentSchema.parse(value);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveAccountErasureLedgerEncryptionKey(sealed.keyId),
    Buffer.from(sealed.initializationVector, "base64"),
    { authTagLength: AUTH_TAG_LENGTH },
  );
  decipher.setAAD(additionalData(sealed));
  decipher.setAuthTag(Buffer.from(sealed.statusTokenAuthTag, "base64"));
  return restoreIntentSchema.parse({
    keyId: sealed.keyId,
    requestId: sealed.requestId,
    requestedAt: sealed.requestedAt,
    statusToken: Buffer.concat([
      decipher.update(Buffer.from(sealed.encryptedStatusToken, "base64")),
      decipher.final(),
    ]).toString("utf8"),
    userHash: sealed.userHash,
  });
}
