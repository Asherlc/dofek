import { timingSafeEqual } from "node:crypto";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { z } from "zod";
import { createR2Client, requiredR2EnvironmentVariable } from "../r2-storage.ts";
import {
  type AccountErasureRestoreIntent,
  openAccountErasureRestoreIntent,
  sealAccountErasureRestoreIntent,
} from "./restore-intent-codec.ts";

const LEDGER_PREFIX = "account-erasure/v1/";
const MAX_LEDGER_LIST_PAGES = 10_000;
const keyIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const userHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export type { AccountErasureRestoreIntent } from "./restore-intent-codec.ts";

export interface AccountErasureRestoreIntentReference {
  keyId: string;
  requestId: string;
  userHash: string;
}

export type AccountErasureRestoreIdentity = Pick<
  AccountErasureRestoreIntentReference,
  "keyId" | "userHash"
>;

export interface AccountErasureRestoreLedger {
  findIntent(
    reference: AccountErasureRestoreIntentReference,
  ): Promise<AccountErasureRestoreIntent | null>;
  listIntentReferences(): Promise<readonly AccountErasureRestoreIntentReference[]>;
  listIntentsForIdentities(
    identities: readonly AccountErasureRestoreIdentity[],
  ): Promise<readonly AccountErasureRestoreIntent[]>;
  recordIntent(intent: AccountErasureRestoreIntent): Promise<void>;
}

function objectKey(keyId: string, userHash: string, requestId: string): string {
  return `${LEDGER_PREFIX}${keyIdSchema.parse(keyId)}/${userHashSchema.parse(userHash)}/${z.uuid().parse(requestId)}.json`;
}

function parseObjectKey(key: string): AccountErasureRestoreIntentReference {
  const malformedKeyError = () =>
    new Error(`Account erasure restore ledger contains malformed object key ${key}`);
  if (!key.startsWith(LEDGER_PREFIX) || !key.endsWith(".json")) {
    throw malformedKeyError();
  }
  const segments = key.slice(LEDGER_PREFIX.length, -".json".length).split("/");
  if (segments.length !== 3) {
    throw malformedKeyError();
  }
  const keyId = keyIdSchema.safeParse(segments[0]);
  const userHash = userHashSchema.safeParse(segments[1]);
  const requestId = z.uuid().safeParse(segments[2]);
  if (!keyId.success || !userHash.success || !requestId.success) {
    throw malformedKeyError();
  }
  return {
    keyId: keyId.data,
    requestId: requestId.data,
    userHash: userHash.data,
  };
}

function isPreconditionFailure(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  if (!("$metadata" in error)) return false;
  const metadata = error.$metadata;
  return (
    metadata !== null &&
    typeof metadata === "object" &&
    "httpStatusCode" in metadata &&
    metadata.httpStatusCode === 412
  );
}

function isNotFound(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  if ("name" in error && (error.name === "NoSuchKey" || error.name === "NotFound")) {
    return true;
  }
  if (!("$metadata" in error)) return false;
  const metadata = error.$metadata;
  return (
    metadata !== null &&
    typeof metadata === "object" &&
    "httpStatusCode" in metadata &&
    metadata.httpStatusCode === 404
  );
}

function restoreIntentsEqual(
  first: AccountErasureRestoreIntent,
  second: AccountErasureRestoreIntent,
): boolean {
  const firstStatusToken = Buffer.from(first.statusToken);
  const secondStatusToken = Buffer.from(second.statusToken);
  return (
    first.keyId === second.keyId &&
    first.requestId === second.requestId &&
    first.requestedAt === second.requestedAt &&
    first.userHash === second.userHash &&
    firstStatusToken.byteLength === secondStatusToken.byteLength &&
    timingSafeEqual(firstStatusToken, secondStatusToken)
  );
}

export class R2AccountErasureRestoreLedger implements AccountErasureRestoreLedger {
  readonly #bucket: string;
  readonly #client: S3Client;

  constructor(client: S3Client, bucket: string) {
    this.#client = client;
    this.#bucket = bucket;
  }

  async findIntent(
    reference: AccountErasureRestoreIntentReference,
  ): Promise<AccountErasureRestoreIntent | null> {
    const key = objectKey(reference.keyId, reference.userHash, reference.requestId);
    try {
      const response = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
      if (!response.Body) {
        throw new Error(`Account erasure restore intent ${key} has no body`);
      }
      const intent = openAccountErasureRestoreIntent(
        JSON.parse(await response.Body.transformToString()),
      );
      if (
        intent.keyId !== reference.keyId ||
        intent.userHash !== reference.userHash ||
        intent.requestId !== reference.requestId
      ) {
        throw new Error(`Account erasure restore intent ${key} does not match its key`);
      }
      return intent;
    } catch (error: unknown) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async recordIntent(intent: AccountErasureRestoreIntent): Promise<void> {
    const sealedIntent = sealAccountErasureRestoreIntent(intent);
    try {
      await this.#client.send(
        new PutObjectCommand({
          Body: JSON.stringify(sealedIntent),
          Bucket: this.#bucket,
          ContentType: "application/json",
          IfNoneMatch: "*",
          Key: objectKey(sealedIntent.keyId, sealedIntent.userHash, sealedIntent.requestId),
        }),
      );
    } catch (error: unknown) {
      if (isPreconditionFailure(error)) {
        const existing = await this.findIntent(intent);
        if (existing && restoreIntentsEqual(existing, intent)) return;
        throw new Error(
          `Account erasure restore intent ${intent.requestId} conflicts with its immutable ledger entry`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async listIntentReferences(): Promise<readonly AccountErasureRestoreIntentReference[]> {
    return this.#listIntentReferencesWithPrefixes([LEDGER_PREFIX]);
  }

  async listIntentsForIdentities(
    identities: readonly AccountErasureRestoreIdentity[],
  ): Promise<readonly AccountErasureRestoreIntent[]> {
    const prefixes = [
      ...new Set(
        identities.map(
          (identity) =>
            `${LEDGER_PREFIX}${keyIdSchema.parse(identity.keyId)}/${userHashSchema.parse(identity.userHash)}/`,
        ),
      ),
    ];
    const references = await this.#listIntentReferencesWithPrefixes(prefixes);
    return Promise.all(
      references.map(async (reference) => {
        const intent = await this.findIntent(reference);
        if (!intent) {
          throw new Error(
            `Account erasure restore intent ${reference.requestId} disappeared during listing`,
          );
        }
        return intent;
      }),
    );
  }

  async #listIntentReferencesWithPrefixes(
    prefixes: readonly string[],
  ): Promise<readonly AccountErasureRestoreIntentReference[]> {
    const references: AccountErasureRestoreIntentReference[] = [];
    for (const prefix of prefixes) {
      let continuationToken: string | undefined;
      let pagesInspected = 0;
      const seenContinuationTokens = new Set<string>();
      do {
        pagesInspected += 1;
        if (pagesInspected > MAX_LEDGER_LIST_PAGES) {
          throw new Error("Account erasure restore ledger listing exceeded the bounded page limit");
        }
        const response = await this.#client.send(
          new ListObjectsV2Command({
            Bucket: this.#bucket,
            ContinuationToken: continuationToken,
            Prefix: prefix,
          }),
        );
        for (const object of response.Contents ?? []) {
          if (!object.Key) {
            throw new Error(
              "Account erasure restore ledger listing returned an object without a key",
            );
          }
          if (!object.Key.startsWith(prefix)) {
            throw new Error(
              `Account erasure restore ledger contains malformed object key ${object.Key}`,
            );
          }
          references.push(parseObjectKey(object.Key));
        }
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
        if (response.IsTruncated && !continuationToken) {
          throw new Error(
            "Account erasure restore ledger listing was truncated without a continuation token",
          );
        }
        if (continuationToken && seenContinuationTokens.has(continuationToken)) {
          throw new Error("Account erasure restore ledger listing repeated a continuation token");
        }
        if (continuationToken) {
          seenContinuationTokens.add(continuationToken);
        }
      } while (continuationToken);
    }
    return references;
  }
}

export function createAccountErasureRestoreLedgerFromEnv(): AccountErasureRestoreLedger {
  return new R2AccountErasureRestoreLedger(
    createR2Client(),
    requiredR2EnvironmentVariable("ACCOUNT_ERASURE_LEDGER_R2_BUCKET"),
  );
}

export function createLazyAccountErasureRestoreLedger(): AccountErasureRestoreLedger {
  let ledger: AccountErasureRestoreLedger | null = null;
  const resolve = (): AccountErasureRestoreLedger => {
    ledger ??= createAccountErasureRestoreLedgerFromEnv();
    return ledger;
  };
  return {
    findIntent: (reference) => resolve().findIntent(reference),
    listIntentReferences: () => resolve().listIntentReferences(),
    listIntentsForIdentities: (identities) => resolve().listIntentsForIdentities(identities),
    recordIntent: (intent) => resolve().recordIntent(intent),
  };
}
