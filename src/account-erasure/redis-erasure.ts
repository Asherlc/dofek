import { z } from "zod";

const SCAN_COUNT = "500";
const DEFAULT_MAX_SCAN_PASSES = 10;
const DEFAULT_PERSISTENCE_POLL_LIMIT = 300;
const DEFAULT_PERSISTENCE_POLL_INTERVAL_MS = 1_000;

const authIdentitySchema = z.object({
  authProvider: z.string().min(1),
  providerAccountId: z.string().min(1),
});

const accountRedisIdentifiersSchema = z.object({
  authIdentities: z.array(authIdentitySchema),
  bullmqJobIds: z.array(z.string().min(1)),
  sessionIds: z.array(z.string().min(1)),
  uploadIds: z.array(z.uuid()),
  userId: z.uuid(),
});

export type AccountRedisIdentifiers = z.infer<typeof accountRedisIdentifiersSchema>;

const oauthStateSchema = z
  .object({
    linkUserId: z.string().optional(),
    userId: z.string(),
  })
  .passthrough();
const oauth1SecretSchema = z.object({ userId: z.string() }).passthrough();
const identityFlowSchema = z
  .object({
    linkUserId: z.string().optional(),
  })
  .passthrough();
const mobileAuthExchangeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      isNewUser: z.boolean(),
      kind: z.literal("session"),
      sessionId: z.string(),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal("provider"),
      providerId: z.string(),
      userId: z.string(),
    })
    .passthrough(),
]);
const pendingEmailSignupSchema = z
  .object({
    providerId: z.string(),
    identity: z
      .object({
        providerAccountId: z.string(),
      })
      .passthrough(),
  })
  .passthrough();
const companionPairingSchema = z
  .object({
    id: z.string().min(1),
    shortCode: z.string().min(1),
    userId: z.string().optional(),
  })
  .passthrough();
const whoopVerificationSchema = z.object({ userId: z.string() }).passthrough();
const slackPendingEntrySchema = z
  .object({
    channelId: z.string().min(1),
    confirmationMessageTs: z.string().min(1),
    id: z.string().min(1),
    userId: z.string(),
  })
  .passthrough();
const uploadOwnedStateSchema = z.object({ userId: z.string() }).passthrough();

interface ManagedJsonNamespace {
  errorLabel: string;
  evaluate(
    key: string,
    payload: string,
    identifiers: AccountRedisIdentifiers,
  ): { companionKeys: readonly string[]; owned: boolean };
  prefix: string;
}

function managedJsonNamespace<T>(config: {
  belongsToAccount(value: T, identifiers: AccountRedisIdentifiers): boolean;
  companionKeys?(key: string, value: T): readonly string[];
  errorLabel: string;
  prefix: string;
  schema: z.ZodType<T>;
}): ManagedJsonNamespace {
  return {
    errorLabel: config.errorLabel,
    evaluate: (key, payload, identifiers) => {
      let decoded: unknown;
      try {
        decoded = JSON.parse(payload);
      } catch {
        throw new Error(
          `Account erasure cannot prove ownership of malformed ${config.errorLabel} Redis state`,
        );
      }
      const parsed = config.schema.safeParse(decoded);
      if (!parsed.success) {
        throw new Error(
          `Account erasure cannot prove ownership of malformed ${config.errorLabel} Redis state`,
        );
      }
      return {
        companionKeys: config.companionKeys?.(key, parsed.data) ?? [],
        owned: config.belongsToAccount(parsed.data, identifiers),
      };
    },
    prefix: config.prefix,
  };
}

const MANAGED_JSON_NAMESPACES: readonly ManagedJsonNamespace[] = [
  managedJsonNamespace({
    belongsToAccount: (value, identifiers) =>
      value.userId === identifiers.userId || value.linkUserId === identifiers.userId,
    errorLabel: "oauth-state",
    prefix: "oauth-state:",
    schema: oauthStateSchema,
  }),
  managedJsonNamespace({
    belongsToAccount: (value, identifiers) => value.userId === identifiers.userId,
    errorLabel: "oauth1-secret",
    prefix: "oauth1-secret:",
    schema: oauth1SecretSchema,
  }),
  managedJsonNamespace({
    belongsToAccount: (value, identifiers) => value.linkUserId === identifiers.userId,
    errorLabel: "identity-flow",
    prefix: "identity-flow:",
    schema: identityFlowSchema,
  }),
  managedJsonNamespace({
    belongsToAccount: (value, identifiers) =>
      value.kind === "provider"
        ? value.userId === identifiers.userId
        : identifiers.sessionIds.includes(value.sessionId),
    errorLabel: "mobile-auth-exchange",
    prefix: "mobile-auth-exchange:",
    schema: mobileAuthExchangeSchema,
  }),
  managedJsonNamespace({
    belongsToAccount: (value, identifiers) =>
      identifiers.authIdentities.some(
        (identity) =>
          identity.authProvider === value.providerId &&
          identity.providerAccountId === value.identity.providerAccountId,
      ),
    companionKeys: (key) => [
      `pending-email-signup-claim:${key.slice("pending-email-signup:".length)}`,
    ],
    errorLabel: "pending-email-signup",
    prefix: "pending-email-signup:",
    schema: pendingEmailSignupSchema,
  }),
  managedJsonNamespace({
    belongsToAccount: (value, identifiers) => value.userId === identifiers.userId,
    companionKeys: (_key, value) => [
      `companion-pairing:{companion-pairing}:code:${value.shortCode}`,
    ],
    errorLabel: "companion-pairing",
    prefix: "companion-pairing:{companion-pairing}:challenge:",
    schema: companionPairingSchema,
  }),
  managedJsonNamespace({
    belongsToAccount: (value, identifiers) => value.userId === identifiers.userId,
    errorLabel: "whoop-verification",
    prefix: "whoop:verification:",
    schema: whoopVerificationSchema,
  }),
  managedJsonNamespace({
    belongsToAccount: (value, identifiers) => value.userId === identifiers.userId,
    companionKeys: (_key, value) => [
      `slack:pending-message:${value.channelId}:${value.confirmationMessageTs}`,
    ],
    errorLabel: "slack-pending-entry",
    prefix: "slack:pending-entry:",
    schema: slackPendingEntrySchema,
  }),
  managedJsonNamespace({
    belongsToAccount: (value, identifiers) => value.userId === identifiers.userId,
    companionKeys: (key) => uploadStateKeys(key.slice("upload-session:".length)),
    errorLabel: "upload-session",
    prefix: "upload-session:",
    schema: uploadOwnedStateSchema,
  }),
  managedJsonNamespace({
    belongsToAccount: (value, identifiers) => value.userId === identifiers.userId,
    companionKeys: (key) => uploadStateKeys(key.slice("upload-status:".length)),
    errorLabel: "upload-status",
    prefix: "upload-status:",
    schema: uploadOwnedStateSchema,
  }),
] as const;

export interface AccountRedisClient {
  bgrewriteaof(): Promise<string>;
  bgsave(schedule: "SCHEDULE"): Promise<string>;
  del(...keys: string[]): Promise<number>;
  get(key: string): Promise<string | null>;
  info(section: "persistence"): Promise<string>;
  scan(
    cursor: string,
    matchKeyword: "MATCH",
    pattern: string,
    countKeyword: "COUNT",
    count: string,
  ): Promise<[string, string[]]>;
  smembers(key: string): Promise<string[]>;
  srem(key: string, ...members: string[]): Promise<number>;
  type(key: string): Promise<string>;
  xdel(key: string, ...ids: string[]): Promise<number>;
  xrange(
    key: string,
    start: string,
    end: string,
    countKeyword: "COUNT",
    count: number,
  ): Promise<Array<[string, string[]]>>;
}

export interface AccountRedisErasureResult {
  aofPersisted: boolean;
  deletedKeys: number;
  deletedStreamEntries: number;
  rdbPersisted: boolean;
  removedSetMembers: number;
  scanPasses: number;
}

interface AccountRedisErasureOptions {
  maxScanPasses?: number;
  persistencePollIntervalMs?: number;
  persistencePollLimit?: number;
  sleep?(milliseconds: number): Promise<void>;
}

interface RedisPersistenceInfo {
  aofEnabled: boolean;
  aofLastRewriteStatus: string;
  aofLastWriteStatus: string;
  aofRewriteInProgress: boolean;
  aofRewriteScheduled: boolean;
  aofRewrites: number;
  rdbLastSaveStatus: string;
  rdbSaveInProgress: boolean;
  rdbSaves: number;
}

function uploadStateKeys(uploadId: string): string[] {
  return [
    `upload-session:${uploadId}`,
    `upload-chunks:${uploadId}`,
    `upload-chunk-bytes:${uploadId}`,
    `upload-status:${uploadId}`,
  ];
}

async function scanKeys(client: AccountRedisClient, pattern: string): Promise<string[]> {
  const keys = new Set<string>();
  let cursor = "0";
  let scans = 0;
  do {
    const [nextCursor, page] = await client.scan(cursor, "MATCH", pattern, "COUNT", SCAN_COUNT);
    for (const key of page) keys.add(key);
    cursor = nextCursor;
    scans += 1;
    if (scans > 10_000) {
      throw new Error("Account erasure Redis SCAN did not converge");
    }
  } while (cursor !== "0");
  return [...keys];
}

async function collectJsonOwnedKeys(
  client: AccountRedisClient,
  namespace: ManagedJsonNamespace,
  identifiers: AccountRedisIdentifiers,
  keysToDelete: Set<string>,
): Promise<void> {
  const keys = await scanKeys(client, `${namespace.prefix}*`);
  for (const key of keys) {
    const keyType = await client.type(key);
    if (keyType !== "string") {
      throw new Error(
        `Account erasure expected string values in the ${namespace.errorLabel} Redis namespace`,
      );
    }
    const payload = await client.get(key);
    if (payload === null) continue;
    const evaluation = namespace.evaluate(key, payload, identifiers);
    if (!evaluation.owned) continue;
    keysToDelete.add(key);
    for (const companionKey of evaluation.companionKeys) {
      keysToDelete.add(companionKey);
    }
  }
}

async function collectOwnedKeys(
  client: AccountRedisClient,
  identifiers: AccountRedisIdentifiers,
): Promise<{
  cacheRegistryMembers: string[];
  keys: Set<string>;
  streamEntries: Map<string, string[]>;
}> {
  const keys = new Set<string>([`companion-pairing-claim-attempts:${identifiers.userId}`]);
  for (const uploadId of identifiers.uploadIds) {
    for (const key of uploadStateKeys(uploadId)) keys.add(key);
  }

  const exactPatternMatches = await Promise.all([
    scanKeys(client, `provider-rate-limit:*:user:${identifiers.userId}`),
    scanKeys(client, `provider-adaptive-rate:*:user:${identifiers.userId}`),
    scanKeys(client, `query-cache:data:${identifiers.userId}:*`),
  ]);
  for (const key of exactPatternMatches.flat()) keys.add(key);

  const slackAccountIds = identifiers.authIdentities
    .filter((identity) => identity.authProvider === "slack")
    .map((identity) => identity.providerAccountId);
  if (slackAccountIds.length > 0) {
    const actionDedupeKeys = await scanKeys(client, "slack:dedupe:action:*");
    for (const key of actionDedupeKeys) {
      if (slackAccountIds.some((accountId) => key.endsWith(`:${accountId}`))) {
        keys.add(key);
      }
    }
  }

  const bullmqKeys = await scanKeys(client, "bull:*");
  const bullmqKeyIdentifiers = [identifiers.userId, ...identifiers.bullmqJobIds];
  for (const key of bullmqKeys) {
    if (
      bullmqKeyIdentifiers.some(
        (identifier) => key.endsWith(`:${identifier}`) || key.includes(`:${identifier}:`),
      )
    ) {
      keys.add(key);
    }
  }

  for (const namespace of MANAGED_JSON_NAMESPACES) {
    await collectJsonOwnedKeys(client, namespace, identifiers, keys);
  }

  const registeredCacheKeys = new Set(await client.smembers("query-cache:keys"));
  const cacheRegistryMembers = [...keys].filter(
    (key) => key.startsWith("query-cache:data:") && registeredCacheKeys.has(key),
  );
  const streamEntries = await collectBullMqStreamEntries(client, identifiers);
  return { cacheRegistryMembers, keys, streamEntries };
}

const bullMqStreamEntrySchema = z.tuple([z.string().min(1), z.array(z.string())]);

function bullMqEventBelongsToAccount(
  fields: readonly string[],
  identifiers: AccountRedisIdentifiers,
): boolean {
  return fields.some(
    (field) => field.includes(identifiers.userId) || identifiers.bullmqJobIds.includes(field),
  );
}

async function collectBullMqStreamEntries(
  client: AccountRedisClient,
  identifiers: AccountRedisIdentifiers,
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const eventStreams = await scanKeys(client, "bull:*:events");
  for (const streamKey of eventStreams) {
    if ((await client.type(streamKey)) !== "stream") {
      throw new Error(
        "Account erasure expected stream values in the BullMQ events Redis namespace",
      );
    }
    let start = "-";
    while (true) {
      const rawEntries = await client.xrange(streamKey, start, "+", "COUNT", 500);
      const entries = z.array(bullMqStreamEntrySchema).parse(rawEntries);
      const attributableIds = entries
        .filter((entry) => bullMqEventBelongsToAccount(entry[1], identifiers))
        .map((entry) => entry[0]);
      if (attributableIds.length > 0) {
        result.set(streamKey, [...(result.get(streamKey) ?? []), ...attributableIds]);
      }
      if (entries.length < 500) break;
      const lastEntry = entries.at(-1);
      if (!lastEntry) break;
      start = `(${lastEntry[0]}`;
    }
  }
  return result;
}

function parsePersistenceInfo(payload: string): RedisPersistenceInfo {
  const rawFields: Record<string, string> = {};
  for (const line of payload.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    rawFields[line.slice(0, separator)] = line.slice(separator + 1);
  }
  const fields = z.record(z.string(), z.string()).parse(rawFields);
  const integerField = (name: string): number =>
    z.coerce.number().int().nonnegative().parse(fields[name]);
  const statusField = (name: string): string => z.string().min(1).parse(fields[name]);
  return {
    aofEnabled: integerField("aof_enabled") === 1,
    aofLastRewriteStatus: statusField("aof_last_bgrewrite_status"),
    aofLastWriteStatus: statusField("aof_last_write_status"),
    aofRewriteInProgress: integerField("aof_rewrite_in_progress") === 1,
    aofRewriteScheduled: integerField("aof_rewrite_scheduled") === 1,
    aofRewrites: integerField("aof_rewrites"),
    rdbLastSaveStatus: statusField("rdb_last_bgsave_status"),
    rdbSaveInProgress: integerField("rdb_bgsave_in_progress") === 1,
    rdbSaves: integerField("rdb_saves"),
  };
}

async function loadPersistenceInfo(client: AccountRedisClient): Promise<RedisPersistenceInfo> {
  return parsePersistenceInfo(await client.info("persistence"));
}

async function waitForPersistence(
  client: AccountRedisClient,
  operation: "AOF" | "RDB",
  completed: (info: RedisPersistenceInfo) => boolean,
  options: Required<
    Pick<AccountRedisErasureOptions, "persistencePollIntervalMs" | "persistencePollLimit" | "sleep">
  >,
): Promise<void> {
  for (let attempt = 0; attempt < options.persistencePollLimit; attempt += 1) {
    const info = await loadPersistenceInfo(client);
    if (completed(info)) return;
    await options.sleep(options.persistencePollIntervalMs);
  }
  throw new Error(`Redis ${operation} persistence did not complete successfully`);
}

async function persistRedisMutations(
  client: AccountRedisClient,
  options: Required<
    Pick<AccountRedisErasureOptions, "persistencePollIntervalMs" | "persistencePollLimit" | "sleep">
  >,
): Promise<{ aofPersisted: boolean; rdbPersisted: boolean }> {
  const initialInfo = await loadPersistenceInfo(client);
  let aofPersisted = false;
  if (initialInfo.aofEnabled) {
    await client.bgrewriteaof();
    await waitForPersistence(
      client,
      "AOF",
      (info) =>
        info.aofRewrites > initialInfo.aofRewrites &&
        !info.aofRewriteInProgress &&
        !info.aofRewriteScheduled &&
        info.aofLastRewriteStatus === "ok" &&
        info.aofLastWriteStatus === "ok",
      options,
    );
    aofPersisted = true;
  }

  const beforeRdb = await loadPersistenceInfo(client);
  await client.bgsave("SCHEDULE");
  await waitForPersistence(
    client,
    "RDB",
    (info) =>
      info.rdbSaves > beforeRdb.rdbSaves &&
      !info.rdbSaveInProgress &&
      info.rdbLastSaveStatus === "ok",
    options,
  );
  return { aofPersisted, rdbPersisted: true };
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function purgeAccountRedisState(
  rawIdentifiers: AccountRedisIdentifiers,
  client: AccountRedisClient,
  options: AccountRedisErasureOptions = {},
): Promise<AccountRedisErasureResult> {
  const identifiers = accountRedisIdentifiersSchema.parse(rawIdentifiers);
  const maxScanPasses = options.maxScanPasses ?? DEFAULT_MAX_SCAN_PASSES;
  const persistenceOptions = {
    persistencePollIntervalMs:
      options.persistencePollIntervalMs ?? DEFAULT_PERSISTENCE_POLL_INTERVAL_MS,
    persistencePollLimit: options.persistencePollLimit ?? DEFAULT_PERSISTENCE_POLL_LIMIT,
    sleep: options.sleep ?? defaultSleep,
  };

  let deletedKeys = 0;
  let deletedStreamEntries = 0;
  let removedSetMembers = 0;
  let scanPasses = 0;
  for (let pass = 1; pass <= maxScanPasses; pass += 1) {
    scanPasses = pass;
    const { cacheRegistryMembers, keys, streamEntries } = await collectOwnedKeys(
      client,
      identifiers,
    );
    const existingKeys: string[] = [];
    for (const key of keys) {
      if ((await client.type(key)) !== "none") existingKeys.push(key);
    }
    const streamEntryCount = [...streamEntries.values()].reduce(
      (total, entryIds) => total + entryIds.length,
      0,
    );
    if (existingKeys.length === 0 && cacheRegistryMembers.length === 0 && streamEntryCount === 0) {
      break;
    }

    if (cacheRegistryMembers.length > 0) {
      removedSetMembers += await client.srem("query-cache:keys", ...cacheRegistryMembers);
    }
    if (existingKeys.length > 0) {
      deletedKeys += await client.del(...existingKeys);
    }
    for (const [streamKey, entryIds] of streamEntries) {
      deletedStreamEntries += await client.xdel(streamKey, ...entryIds);
    }

    if (pass === maxScanPasses) {
      throw new Error(
        "Account erasure Redis state continued changing after the bounded cleanup passes",
      );
    }
  }

  const persistence = await persistRedisMutations(client, persistenceOptions);
  return {
    ...persistence,
    deletedKeys,
    deletedStreamEntries,
    removedSetMembers,
    scanPasses,
  };
}
