import { z } from "zod";

const CAPTURE_DEADLINE_MS = 60_000;
const MAX_ADMIN_RESPONSE_BYTES = 8 * 1024 * 1024;

const nativeCoordinateSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);

const streamShape = {
  epoch: z.string().min(1),
  topic: z.string().min(1),
  partition: z.number().int().min(-1).max(2147483647),
};

const deliverySchema = z.strictObject({
  major: nativeCoordinateSchema,
  minor: nativeCoordinateSchema,
  batch: z.number().int().min(-1).max(2147483647),
});

/** Root-shaped native fence: topic/epoch/partition plus empty or delivery coords. */
export const accountErasureNativeFenceSchema = z.discriminatedUnion("state", [
  z.strictObject({
    transport: z.literal("pulsar"),
    state: z.literal("empty"),
    ...streamShape,
  }),
  z.strictObject({
    transport: z.literal("pulsar"),
    state: z.literal("message"),
    ...streamShape,
    delivery: deliverySchema,
  }),
]);

export type AccountErasureNativeFence = z.infer<typeof accountErasureNativeFenceSchema>;

const signedInt64StringSchema = z
  .string()
  .regex(/^-?(0|[1-9]\d*)$/)
  .refine((value) => {
    const parsed = BigInt(value);
    return parsed >= -9223372036854775808n && parsed <= 9223372036854775807n;
  });

/**
 * Minimal lastMessageId fence progress for ingest checkpoints.
 * No per-request managed-ledger inventory, digest binding, or physical proof math.
 */
export const accountErasureNativeFenceProgressSchema = z.strictObject({
  fence: accountErasureNativeFenceSchema,
});

export type AccountErasureNativeFenceProgress = z.infer<
  typeof accountErasureNativeFenceProgressSchema
>;

const lastMessageIdSchema = z
  .object({
    ledgerId: signedInt64StringSchema,
    entryId: signedInt64StringSchema,
    partitionIndex: z.number().int().min(-1).max(2147483647),
    batchIndex: z.number().int().min(-1).max(2147483647),
    batchSize: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const markDeletePositionSchema = z
  .string()
  .regex(/^(-1|[0-9]+):(-1|[0-9]+)$/)
  .transform((value) => {
    const [major = "", minor = ""] = value.split(":");
    return { major, minor };
  });

const cursorStatsSchema = z
  .object({
    markDeletePosition: markDeletePositionSchema,
    individuallyDeletedMessages: z.string(),
    totalNonContiguousDeletedMessagesRange: z.number().int().nonnegative().optional(),
  })
  .passthrough();

/** Drain assert: cursors required per subscription. */
const drainInternalStatsSchema = z
  .object({
    cursors: z.record(z.string(), cursorStatsSchema).optional(),
    lastConfirmedEntry: z.string().optional(),
  })
  .passthrough();

/**
 * Stock admin surface used by fence capture and ACK drain.
 * Namespace retention/TTL/quota policy is verified by stock maintenance/deploy checks,
 * not per-request capture.
 */
export interface PulsarDrainAdmin {
  getLastMessageId(topic: string, signal: AbortSignal): Promise<unknown>;
  getInternalStats(topic: string, signal: AbortSignal): Promise<unknown>;
  getTopicPartitions(topic: string, signal: AbortSignal): Promise<unknown>;
}

const topicPartitionMetadataSchema = z
  .object({
    partitions: z.number().int().nonnegative(),
  })
  .passthrough();

export interface AccountErasureNativeDrainRoute {
  topic: string;
  subscriptions: readonly string[];
}

export interface AccountErasureNativeDrainStream {
  epoch: string;
  topic: string;
  partition: number;
  subscriptions: readonly string[];
}

const INT64_JSON_KEYS = new Set([
  "ledgerId",
  "entryId",
  "entries",
  "size",
  "cursorLedger",
  "cursorLedgerLastEntry",
  "messagesConsumedCounter",
  "numberOfEntriesSinceFirstNotAckedMessage",
]);

interface JsonParseReviverContext {
  source: string;
}

/**
 * Built-in JSON.parse source-text reviver for int64 ID keys.
 * https://tc39.es/ecma262/multipage/structured-data.html#sec-json.parse
 */
function parsePulsarAdminJson(raw: string): unknown {
  return JSON.parse(
    raw,
    function revivePulsarAdminValue(
      key: string,
      value: unknown,
      context?: JsonParseReviverContext,
    ): unknown {
      if (!INT64_JSON_KEYS.has(key) || typeof value !== "number") return value;
      if (context === undefined || typeof context.source !== "string") {
        throw new Error(`Pulsar admin JSON missing source text for ${key}`);
      }
      if (!/^-?(0|[1-9]\d*)$/.test(context.source)) {
        throw new Error(`Pulsar admin JSON ${key} is not a decimal int64 literal`);
      }
      return context.source;
    },
  );
}

function compareEntry(
  left: { major: string; minor: string },
  right: { major: string; minor: string },
): number {
  const leftMajor = BigInt(left.major);
  const rightMajor = BigInt(right.major);
  if (leftMajor !== rightMajor) return leftMajor < rightMajor ? -1 : 1;
  const leftMinor = BigInt(left.minor);
  const rightMinor = BigInt(right.minor);
  if (leftMinor === rightMinor) return 0;
  return leftMinor < rightMinor ? -1 : 1;
}

function parsePersistentTopic(topic: string): {
  tenant: string;
  namespace: string;
  name: string;
} {
  const match = /^persistent:\/\/([^/]+)\/([^/]+)\/(.+)$/.exec(topic);
  if (!match) throw new Error("Native drain requires one concrete persistent Pulsar topic");
  const [, tenant = "", namespace = "", name = ""] = match;
  return { tenant, namespace, name };
}

function assertCaptureWithinDeadline(signal: AbortSignal, startedAtMs: number): void {
  if (signal.aborted) {
    const reason = signal.reason;
    const detail =
      reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "aborted";
    throw new Error(`Native capture aborted before completing within deadline (${detail})`);
  }
  const elapsedMs = performance.now() - startedAtMs;
  if (elapsedMs > CAPTURE_DEADLINE_MS) {
    throw new Error(
      `Native fence capture exceeded ${CAPTURE_DEADLINE_MS}ms deadline (${Math.ceil(elapsedMs)}ms)`,
    );
  }
}

function fenceFromLastMessageId(
  stream: Pick<AccountErasureNativeFence, "epoch" | "topic" | "partition">,
  lastMessageId: z.infer<typeof lastMessageIdSchema>,
): AccountErasureNativeFence {
  if (lastMessageId.partitionIndex !== stream.partition) {
    throw new Error(
      `Native fence partition ${lastMessageId.partitionIndex} differs from owned stream partition ${stream.partition}`,
    );
  }
  if (lastMessageId.entryId === "-1") {
    return accountErasureNativeFenceSchema.parse({
      transport: "pulsar",
      state: "empty",
      epoch: stream.epoch,
      topic: stream.topic,
      partition: stream.partition,
    });
  }
  return accountErasureNativeFenceSchema.parse({
    transport: "pulsar",
    state: "message",
    epoch: stream.epoch,
    topic: stream.topic,
    partition: stream.partition,
    delivery: {
      major: lastMessageId.ledgerId,
      minor: lastMessageId.entryId,
      batch: lastMessageId.batchIndex,
    },
  });
}

/**
 * lastMessageId fence capture. Owns one 60s AbortSignal for the admin read.
 * Namespace retention/TTL/quota policy is outside this path (stock maintenance/deploy).
 */
export async function captureAccountErasureNativeFenceProgress(
  admin: PulsarDrainAdmin,
  stream: Pick<AccountErasureNativeFence, "epoch" | "topic" | "partition">,
): Promise<AccountErasureNativeFenceProgress> {
  if (!stream.epoch || !stream.topic) throw new Error("Native fence requires epoch and topic");
  if (!Number.isInteger(stream.partition) || stream.partition < -1 || stream.partition > 2147483647)
    throw new Error("Native fence partition must be an int32 partition or -1");
  parsePersistentTopic(stream.topic);
  const signal = AbortSignal.timeout(CAPTURE_DEADLINE_MS);
  const startedAtMs = performance.now();
  assertCaptureWithinDeadline(signal, startedAtMs);
  const lastMessageId = lastMessageIdSchema.parse(
    await admin.getLastMessageId(stream.topic, signal),
  );
  assertCaptureWithinDeadline(signal, startedAtMs);
  return accountErasureNativeFenceProgressSchema.parse({
    fence: fenceFromLastMessageId(stream, lastMessageId),
  });
}

/**
 * Prove each durable subscription's mark-delete is contiguous through the fence.
 * Owns one bounded operation signal for the stats read. ACK cursor only — not expiry proof.
 */
export async function assertAccountErasureSubscriptionsDrained(
  admin: PulsarDrainAdmin,
  fence: AccountErasureNativeFence,
  subscriptions: readonly string[],
): Promise<void> {
  const validated = accountErasureNativeFenceSchema.parse(fence);
  if (subscriptions.length === 0)
    throw new Error("Native drain requires at least one subscription");
  const signal = AbortSignal.timeout(CAPTURE_DEADLINE_MS);
  const stats = drainInternalStatsSchema.parse(
    await admin.getInternalStats(validated.topic, signal),
  );
  const lagging: string[] = [];
  for (const subscription of subscriptions) {
    const cursor = stats.cursors?.[subscription];
    if (!cursor) {
      lagging.push(subscription);
      continue;
    }
    if (validated.state === "empty") continue;
    const markDelete = cursor.markDeletePosition;
    // markDeletePosition is inclusive of the last contiguous ACK'd entry (broker observation).
    if (compareEntry(markDelete, validated.delivery) < 0) lagging.push(subscription);
  }
  if (lagging.length > 0) {
    throw new Error(
      `Account erasure is waiting for contiguous native ACK through the fence for subscription(s): ${lagging.join(", ")}`,
    );
  }
}

function compareNativeIngestStreams(
  left: AccountErasureNativeFenceProgress,
  right: AccountErasureNativeFenceProgress,
): number {
  if (left.fence.topic !== right.fence.topic) {
    return left.fence.topic < right.fence.topic ? -1 : 1;
  }
  if (left.fence.partition !== right.fence.partition) {
    return left.fence.partition < right.fence.partition ? -1 : 1;
  }
  return 0;
}

/** Stable topic-then-partition order for request-level ingest checkpoints. */
export function orderAccountErasureNativeIngestStreams(
  streams: readonly AccountErasureNativeFenceProgress[],
): AccountErasureNativeFenceProgress[] {
  return [...streams].sort(compareNativeIngestStreams);
}

/**
 * Request-level native ingest fence checkpoint: nonempty unique (topic,partition)
 * streams in fixed topic/partition order. lastMessageId fences only — not Kafka
 * highWatermarks and not per-request ledger inventory.
 */
export const accountErasureNativeIngestCheckpointSchema = z
  .strictObject({
    streams: z.array(accountErasureNativeFenceProgressSchema).min(1),
  })
  .superRefine((value, context) => {
    const seen = new Set<string>();
    let previous: AccountErasureNativeFenceProgress | undefined;
    for (const [index, stream] of value.streams.entries()) {
      const key = `${stream.fence.topic}:${stream.fence.partition}`;
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate native ingest stream for ${stream.fence.topic} partition ${stream.fence.partition}`,
          path: ["streams", index],
        });
      }
      seen.add(key);
      if (previous && compareNativeIngestStreams(previous, stream) >= 0) {
        context.addIssue({
          code: "custom",
          message: "Native ingest streams must be strictly ordered by topic then partition",
          path: ["streams", index],
        });
      }
      previous = stream;
    }
  });

export type AccountErasureNativeIngestCheckpoint = z.infer<
  typeof accountErasureNativeIngestCheckpointSchema
>;

export function buildAccountErasureNativeIngestCheckpoint(
  streams: readonly AccountErasureNativeFenceProgress[],
): AccountErasureNativeIngestCheckpoint {
  return accountErasureNativeIngestCheckpointSchema.parse({
    streams: orderAccountErasureNativeIngestStreams(streams),
  });
}

function partitionTopicName(topic: string, partitionIndex: number): string {
  const match = /^(persistent:\/\/[^/]+\/[^/]+\/)(.+)$/.exec(topic);
  if (!match) throw new Error("Native drain requires one concrete persistent Pulsar topic");
  return `${match[1]}${match[2]}-partition-${partitionIndex}`;
}

/**
 * Expand caller-explicit consumer routes into concrete drain streams using stock
 * `/partitions` metadata. `partitions: 0` → one stream at partition `-1`; `N > 0` →
 * concrete `…-partition-0..N-1` topics with matching partition indexes. Does not invent
 * subscription names. Epoch required at composition. Owns one bounded operation signal.
 */
export async function resolveAccountErasureNativeDrainStreams(
  admin: PulsarDrainAdmin,
  options: {
    epoch: string;
    routes: readonly AccountErasureNativeDrainRoute[];
  },
): Promise<AccountErasureNativeDrainStream[]> {
  if (!options.epoch.trim()) throw new Error("Native drain requires METRIC_STREAM_TRANSPORT_EPOCH");
  if (options.routes.length === 0) throw new Error("Native drain requires at least one route");
  const signal = AbortSignal.timeout(CAPTURE_DEADLINE_MS);
  const streams: AccountErasureNativeDrainStream[] = [];
  for (const route of options.routes) {
    parsePersistentTopic(route.topic);
    if (route.subscriptions.length === 0) {
      throw new Error(`Native drain route ${route.topic} requires explicit subscriptions`);
    }
    for (const subscription of route.subscriptions) {
      if (!subscription.trim()) {
        throw new Error(`Native drain route ${route.topic} has an empty subscription name`);
      }
    }
    const metadata = topicPartitionMetadataSchema.parse(
      await admin.getTopicPartitions(route.topic, signal),
    );
    if (metadata.partitions === 0) {
      streams.push({
        epoch: options.epoch,
        topic: route.topic,
        partition: -1,
        subscriptions: route.subscriptions,
      });
      continue;
    }
    for (let partitionIndex = 0; partitionIndex < metadata.partitions; partitionIndex += 1) {
      streams.push({
        epoch: options.epoch,
        topic: partitionTopicName(route.topic, partitionIndex),
        partition: partitionIndex,
        subscriptions: route.subscriptions,
      });
    }
  }
  return streams;
}

async function readBoundedAdminBody(response: Response, path: string): Promise<string> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null) {
    const length = Number(lengthHeader);
    if (Number.isFinite(length) && length > MAX_ADMIN_RESPONSE_BYTES) {
      if (response.body) await response.body.cancel();
      throw new Error(
        `Pulsar admin ${path} Content-Length ${length} exceeds ${MAX_ADMIN_RESPONSE_BYTES} byte stream limit`,
      );
    }
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_ADMIN_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(
          `Pulsar admin ${path} body exceeds ${MAX_ADMIN_RESPONSE_BYTES} byte stream limit`,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Already cancelled or closed.
    }
    throw error;
  }
  if (chunks.length === 0) return "";
  if (chunks.length === 1) return new TextDecoder().decode(chunks[0]);
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** HTTP admin factory. Operation deadline is the required `signal` on each method call. */
export function createPulsarDrainAdminFromUrls(options: { adminUrl: string }): PulsarDrainAdmin {
  const base = options.adminUrl.replace(/\/$/, "");
  async function request(path: string, signal: AbortSignal): Promise<unknown> {
    const response = await fetch(`${base}${path}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(CAPTURE_DEADLINE_MS)]),
    });
    if (!response.ok) {
      if (response.body) await response.body.cancel();
      throw new Error(`Pulsar admin ${path} failed with HTTP ${response.status}`);
    }
    const raw = await readBoundedAdminBody(response, path);
    if (raw.trim() === "" || raw.trim() === "null") return null;
    return parsePulsarAdminJson(raw);
  }
  function topicPath(topic: string): string {
    const { tenant, namespace, name } = parsePersistentTopic(topic);
    return `/admin/v2/persistent/${encodeURIComponent(tenant)}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
  }
  return {
    getLastMessageId: (topic, signal) => request(`${topicPath(topic)}/lastMessageId`, signal),
    getInternalStats: (topic, signal) => request(`${topicPath(topic)}/internalStats`, signal),
    getTopicPartitions: (topic, signal) => request(`${topicPath(topic)}/partitions`, signal),
  };
}
