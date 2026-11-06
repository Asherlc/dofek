import { Readable } from "node:stream";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import Pulsar from "pulsar-client";
import {
  type AccountErasureDeliveryFenceDatabase,
  withAccountErasureDeliveryFence,
} from "../db/account-erasure-delivery-fence.ts";
import { createDatabaseFromEnv, type Database } from "../db/index.ts";
import { captureException } from "../lib/error-reporting.ts";
import { createR2Client, requiredR2EnvironmentVariable } from "../r2-storage.ts";
import {
  createMetricStreamConsumerReadinessServer,
  MetricStreamConsumerReadiness,
} from "./consumer-readiness.ts";
import {
  isMetricStreamBatchCompletedEvent,
  isMetricStreamDeletedEvent,
  type MetricStreamRedpandaEvent,
  metricStreamRedpandaEventSchema,
} from "./events.ts";
import {
  type PulsarMetricStreamBatchContext,
  runPulsarMetricStreamConsumer,
} from "./pulsar-consumer.ts";
import { parseMetricStreamArchiveObjectKey } from "./r2-replay.ts";

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const MAX_GROUP_BYTES = 8 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 900_000;
/** Delivery-group line count bound; each retained line contributes one trailing LF. */
const MAX_ARCHIVE_LINES = 500;
/** Uncompressed JSONL ceiling: payload bound plus one LF per allowed line. */
const MAX_DECOMPRESSED_ARCHIVE_BYTES = MAX_GROUP_BYTES + MAX_ARCHIVE_LINES;
/**
 * Gzip encoding allowance so near-limit incompressible JSONL still fits the
 * compressed ceiling. Conservative literal (not exact minimal): retain zlib's
 * full documented `compressBound`
 * (`sourceLen + (sourceLen>>12) + (sourceLen>>14) + (sourceLen>>25) + 13`) and
 * add the gzip frame allowance (+18 header/trailer). That keeps the zlib wrap
 * counted in `+13` and stacks the gzip frame on top (~13 bytes extra encoding
 * overhead vs a zlib/gzip-delta rewrite; not a payload-limit raise).
 * https://www.zlib.net/manual.html (compressBound);
 * https://nodejs.org/api/zlib.html#zlib-constants;
 * https://datatracker.ietf.org/doc/html/rfc1952.
 */
const GZIP_ENCODING_OVERHEAD_BYTES =
  (MAX_DECOMPRESSED_ARCHIVE_BYTES >> 12) +
  (MAX_DECOMPRESSED_ARCHIVE_BYTES >> 14) +
  (MAX_DECOMPRESSED_ARCHIVE_BYTES >> 25) +
  13 +
  18;
const MAX_COMPRESSED_ARCHIVE_BYTES = MAX_DECOMPRESSED_ARCHIVE_BYTES + GZIP_ENCODING_OVERHEAD_BYTES;

function isCreateCollision(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (!("$metadata" in error)) return false;
  const metadata = error.$metadata;
  if (typeof metadata !== "object" || metadata === null) return false;
  if (!("httpStatusCode" in metadata)) return false;
  return metadata.httpStatusCode === 412;
}

function deliveryIsFenced(event: MetricStreamRedpandaEvent, fenced: ReadonlySet<string>): boolean {
  const accountIds = knownAccountIdsForFence(event);
  return accountIds.length > 0 && accountIds.every((userId) => fenced.has(userId.toLowerCase()));
}

/**
 * Create-only collision: existing object may still contain pre-activation fenced
 * rows. Re-filter its JSONL with the same held fence set and require exact byte
 * equality of the retained original lines (no subset/superset acceptance).
 */
async function verifyCollision(
  client: S3Client,
  bucket: string,
  key: string,
  expectedRetainedJsonl: Buffer,
  fenced: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<void> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
    abortSignal: signal,
  });
  if (
    typeof response.ContentLength === "number" &&
    response.ContentLength > MAX_COMPRESSED_ARCHIVE_BYTES
  ) {
    throw new Error("Archive collision content exceeds compressed size bound");
  }
  if (!(response.Body instanceof Readable))
    throw new Error("Archive collision content has no readable body");
  const chunks: Buffer[] = [];
  let compressedBytes = 0;
  for await (const chunk of response.Body) {
    signal.throwIfAborted();
    if (!(chunk instanceof Uint8Array))
      throw new Error("Archive collision content has a non-byte chunk");
    compressedBytes += chunk.byteLength;
    if (compressedBytes > MAX_COMPRESSED_ARCHIVE_BYTES)
      throw new Error("Archive collision content exceeds compressed size bound");
    chunks.push(Buffer.from(chunk));
  }
  let decompressed: Buffer;
  try {
    // Stock zlib convenience bound — rejects bombs before allocating past the ceiling.
    // https://nodejs.org/api/zlib.html#zlib-constants (maxOutputLength)
    decompressed = await decompress(Buffer.concat(chunks), {
      maxOutputLength: MAX_DECOMPRESSED_ARCHIVE_BYTES,
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ERR_BUFFER_TOO_LARGE"
    ) {
      throw new Error("Archive collision content exceeds decompressed size bound");
    }
    throw new Error("Archive collision content is not a valid gzip archive");
  }
  if (decompressed.length === 0 || decompressed[decompressed.length - 1] !== 10)
    throw new Error("Archive collision content is not newline-terminated JSONL");

  const retained: Buffer[] = [];
  let offset = 0;
  let lineCount = 0;
  while (offset < decompressed.length) {
    const next = decompressed.indexOf(10, offset);
    if (next < 0) throw new Error("Archive collision content is not newline-terminated JSONL");
    lineCount += 1;
    if (lineCount > MAX_ARCHIVE_LINES)
      throw new Error("Archive collision content exceeds line count bound");
    const line = decompressed.subarray(offset, next);
    offset = next + 1;
    if (!line.length) throw new Error("Archive collision content contains an empty JSONL line");
    if (line.includes(13))
      throw new Error("Archive collision content contains a carriage-return delimiter");
    let event: MetricStreamRedpandaEvent;
    try {
      event = metricStreamRedpandaEventSchema.parse(JSON.parse(line.toString("utf8")));
    } catch {
      throw new Error("Archive collision content contains an unparseable metric-stream line");
    }
    if (!deliveryIsFenced(event, fenced)) {
      retained.push(line, Buffer.from("\n"));
    }
  }

  const filtered = Buffer.concat(retained);
  if (!filtered.equals(expectedRetainedJsonl))
    throw new Error("Archive collision content differs from the expected retained upload");
}

/**
 * Known account ids for the delivery fence.
 *
 * Rows, deletes with `scope.userId`, and v2 batch_completed markers participate.
 * Legacy ownerless markers/deletes are rejected before PUT on the native archive
 * path — they remain parseable for history/eraser only.
 */
function knownAccountIdsForFence(event: MetricStreamRedpandaEvent): string[] {
  if (isMetricStreamBatchCompletedEvent(event)) {
    return "userId" in event ? [event.userId] : [];
  }
  if (isMetricStreamDeletedEvent(event)) {
    return event.scope.userId ? [event.scope.userId] : [];
  }
  return [event.userId];
}

/** Fail closed before PUT when a live delivery cannot resolve account ownership. */
function assertArchiveDeliveryOwnershipResolved(
  events: readonly MetricStreamRedpandaEvent[],
): void {
  for (const event of events) {
    if (isMetricStreamBatchCompletedEvent(event) && !("userId" in event)) {
      throw new Error(
        "Archive rejects ownerless batch_completed markers on the native subscription",
      );
    }
    if (isMetricStreamDeletedEvent(event) && !event.scope.userId) {
      throw new Error("Archive rejects ownerless delete controls on the native subscription");
    }
  }
}

/**
 * Schema-parse each delivery after wire bounds. Fail closed with a sanitized
 * message — never echo payload bytes into the error.
 */
function parseArchiveWireEvents(
  context: PulsarMetricStreamBatchContext,
): MetricStreamRedpandaEvent[] {
  return context.deliveries.map((delivery) => {
    try {
      return metricStreamRedpandaEventSchema.parse(JSON.parse(delivery.data.toString("utf8")));
    } catch {
      throw new Error("Archive delivery payload is not a parseable metric-stream event");
    }
  });
}

/** Original upload provenance only: regrouped redelivery may create overlapping objects. */
export async function archiveMetricStreamDeliveries(
  client: S3Client,
  bucket: string,
  context: PulsarMetricStreamBatchContext,
  database: AccountErasureDeliveryFenceDatabase,
  signal: AbortSignal,
): Promise<void> {
  if (
    !context.deliveries.length ||
    context.deliveries.length > 500 ||
    context.positions.length !== context.deliveries.length
  )
    throw new Error("Archive requires one bounded group with a position for every delivery");

  // Wire bounds before schema parse so size/UTF-8/delimiter failures stay fail-closed
  // without requiring a parseable event body.
  let totalBytes = 0;
  for (const [index, delivery] of context.deliveries.entries()) {
    const position = context.positions[index];
    if (
      position?.transport !== "pulsar" ||
      position.topic !== context.topic ||
      position.partition !== context.partition
    )
      throw new Error("Archive requires the original native position for its concrete topic");
    const data = delivery.data;
    totalBytes += data.length;
    if (!data.length || data.length > MAX_PAYLOAD_BYTES)
      throw new Error("Archive payload must be between 1 and 900000 bytes");
    if (!Buffer.from(data.toString("utf8"), "utf8").equals(data))
      throw new Error("Archive payload is not valid UTF-8");
    if (data.includes(10) || data.includes(13))
      throw new Error("Archive payload contains a JSONL line delimiter");
    if (totalBytes > MAX_GROUP_BYTES) throw new Error("Archive payload group exceeds 8MiB");
    if (
      !Number.isSafeInteger(delivery.publishTimestamp) ||
      delivery.publishTimestamp < 0 ||
      delivery.publishTimestamp > 8640000000000000
    )
      throw new Error("Archive requires a valid native publish timestamp");
  }

  const aligned = parseArchiveWireEvents(context);
  assertArchiveDeliveryOwnershipResolved(aligned);
  const accountIds = aligned.flatMap((event) => knownAccountIdsForFence(event));
  // One owned group deadline composed with the process signal across compress /
  // PUT / collision GET+body. Stock AbortSignal only — no retries.
  // https://nodejs.org/api/globals.html#class-abortsignal
  const groupSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);

  await withAccountErasureDeliveryFence(database, accountIds, async (fenced) => {
    const runs: Array<{
      key: string;
      data: Buffer[];
      hour: string;
      first: string;
      last: string;
      epoch: string;
      retained: number;
    }> = [];
    for (const [index, delivery] of context.deliveries.entries()) {
      const position = context.positions[index];
      const event = aligned[index];
      if (!event || !position || position.transport !== "pulsar")
        throw new Error("Archive event is missing for its delivery");
      const data = delivery.data;
      const timestamp = new Date(delivery.publishTimestamp).toISOString();
      const hour = `date=${timestamp.slice(0, 10)}/hour=${timestamp.slice(11, 13)}`;
      const hex = Buffer.from(position.serializedMessageId, "base64").toString("hex");
      let run = runs.at(-1);
      if (!run || run.hour !== hour) {
        run = {
          key: "",
          data: [],
          hour,
          first: hex,
          last: hex,
          epoch: position.epoch,
          retained: 0,
        };
        runs.push(run);
      }
      if (run.epoch !== position.epoch)
        throw new Error("Archive group crosses native transport epochs");
      // Nonempty-run key provenance spans the original received range, including
      // fenced members that will not appear in the uploaded body.
      run.last = hex;
      if (!deliveryIsFenced(event, fenced)) {
        run.data.push(data, Buffer.from("\n"));
        run.retained += 1;
      }
    }

    for (const run of runs) {
      if (run.retained === 0) continue;
      run.key = `metric-stream/v1/${run.hour}/pulsar/epoch=${encodeURIComponent(run.epoch)}/topic=${encodeURIComponent(context.topic)}/first=${run.first}/last=${run.last}.jsonl.gz`;
      parseMetricStreamArchiveObjectKey(run.key);
    }

    for (const run of runs) {
      if (run.retained === 0) continue;
      await context.assertActive();
      groupSignal.throwIfAborted();
      const retainedJsonl = Buffer.concat(run.data);
      const body = await compress(retainedJsonl);
      await context.assertActive();
      groupSignal.throwIfAborted();
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: run.key,
            Body: body,
            ContentEncoding: "gzip",
            ContentType: "application/x-ndjson",
            IfNoneMatch: "*",
          }),
          { abortSignal: groupSignal },
        );
      } catch (error) {
        if (!isCreateCollision(error)) throw error;
        await verifyCollision(client, bucket, run.key, retainedJsonl, fenced, groupSignal);
      }
      await context.assertActive();
      groupSignal.throwIfAborted();
    }
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function startMetricStreamR2ArchiveFromEnv(): Promise<void> {
  const readiness = new MetricStreamConsumerReadiness();
  const server = createMetricStreamConsumerReadinessServer(readiness);
  const controller = new AbortController();
  const stop = () => {
    readiness.markUnavailable();
    controller.abort();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  let native: Pulsar.Client | undefined;
  let storage: S3Client | undefined;
  let database: Database | undefined;
  let failed = false;
  let failure: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    const serviceUrl = requiredEnvironment("PULSAR_SERVICE_URL");
    const topic = requiredEnvironment("METRIC_STREAM_TOPIC");
    const epoch = requiredEnvironment("METRIC_STREAM_TRANSPORT_EPOCH");
    const subscription = requiredEnvironment("METRIC_STREAM_SUBSCRIPTION");
    const bucket = requiredR2EnvironmentVariable("METRIC_STREAM_R2_BUCKET");
    if (/[\r\n\u2028\u2029]/u.test(topic) || !/^persistent:\/\/[^/]+\/[^/]+\/[^/]+$/.test(topic))
      throw new Error("METRIC_STREAM_TOPIC must name one concrete persistent Pulsar topic");
    const db = createDatabaseFromEnv();
    database = db;
    storage = createR2Client();
    native = new Pulsar.Client({ serviceUrl });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(3001, "0.0.0.0");
    });
    server.unref();
    const ownedStorage = storage;
    await runPulsarMetricStreamConsumer({
      client: native,
      readiness,
      topic,
      partition: -1,
      epoch,
      subscription,
      receiverQueueSize: 20,
      nativeBatchMessages: 20,
      nativeBatchBytes: MAX_GROUP_BYTES,
      maxGroupMessages: 500,
      maxGroupBytes: MAX_GROUP_BYTES,
      signal: controller.signal,
      loadPendingGroup: async () => null,
      handleEvents: async (_events, context) =>
        archiveMetricStreamDeliveries(ownedStorage, bucket, context, db, controller.signal),
    });
  } catch (error) {
    failed = true;
    failure = error;
    captureException(error, {
      tags: { metricStreamConsumer: "r2-archive", metricStreamFailure: "runtime" },
    });
  } finally {
    readiness.markUnavailable();
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    const ownedNative = native,
      ownedStorage = storage,
      ownedDatabase = database;
    const closing: Promise<unknown>[] = [];
    if (ownedNative) closing.push(Promise.resolve().then(() => ownedNative.close()));
    if (ownedStorage) closing.push(Promise.resolve().then(() => ownedStorage.destroy()));
    if (ownedDatabase) closing.push(Promise.resolve().then(() => ownedDatabase.$client.end()));
    if (server.listening)
      closing.push(
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
      );
    for (const result of await Promise.allSettled(closing))
      if (result.status === "rejected") {
        cleanupErrors.push(result.reason);
        captureException(result.reason, {
          tags: { metricStreamConsumer: "r2-archive", metricStreamFailure: "cleanup" },
        });
      }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      failed ? [failure, ...cleanupErrors] : cleanupErrors,
      "Metric-stream archive and cleanup failed",
    );
  if (failed) throw failure;
}
