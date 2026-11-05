import { Readable } from "node:stream";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import Pulsar from "pulsar-client";
import { captureException } from "../lib/error-reporting.ts";
import { createR2Client, requiredR2EnvironmentVariable } from "../r2-storage.ts";
import {
  createMetricStreamConsumerReadinessServer,
  MetricStreamConsumerReadiness,
} from "./consumer-readiness.ts";
import {
  type PulsarMetricStreamBatchContext,
  runPulsarMetricStreamConsumer,
} from "./pulsar-consumer.ts";
import { parseMetricStreamArchiveObjectKey } from "./r2-replay.ts";

const compress = promisify(gzip);
const MAX_GROUP_BYTES = 8 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 900_000;

function isCreateCollision(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "$metadata" in error &&
    typeof error.$metadata === "object" &&
    error.$metadata !== null &&
    "httpStatusCode" in error.$metadata &&
    error.$metadata.httpStatusCode === 412
  );
}

async function verifyCollision(
  client: S3Client,
  bucket: string,
  key: string,
  expected: Buffer,
  signal: AbortSignal,
): Promise<void> {
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
    abortSignal: signal,
  });
  if (!(response.Body instanceof Readable))
    throw new Error("Archive collision content has no readable body");
  let offset = 0;
  for await (const chunk of response.Body) {
    if (
      !(chunk instanceof Uint8Array) ||
      offset + chunk.byteLength > expected.length ||
      !expected.subarray(offset, offset + chunk.byteLength).equals(Buffer.from(chunk))
    )
      throw new Error("Archive collision content differs from the original upload");
    offset += chunk.byteLength;
  }
  if (offset !== expected.length) throw new Error("Archive collision content is incomplete");
}

/** Original upload provenance only: regrouped redelivery may create overlapping objects. */
export async function archiveMetricStreamDeliveries(
  client: S3Client,
  bucket: string,
  context: PulsarMetricStreamBatchContext,
  signal: AbortSignal,
): Promise<void> {
  if (
    !context.deliveries.length ||
    context.deliveries.length > 500 ||
    context.positions.length !== context.deliveries.length
  )
    throw new Error("Archive requires one bounded group with a position for every delivery");
  const runs: Array<{
    key: string;
    data: Buffer[];
    hour: string;
    first: string;
    last: string;
    epoch: string;
  }> = [];
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
    const timestamp = new Date(delivery.publishTimestamp).toISOString();
    const hour = `date=${timestamp.slice(0, 10)}/hour=${timestamp.slice(11, 13)}`;
    const hex = Buffer.from(position.serializedMessageId, "base64").toString("hex");
    let run = runs.at(-1);
    if (!run || run.hour !== hour) {
      run = { key: "", data: [], hour, first: hex, last: hex, epoch: position.epoch };
      runs.push(run);
    }
    if (run.epoch !== position.epoch)
      throw new Error("Archive group crosses native transport epochs");
    run.last = hex;
    run.data.push(data, Buffer.from("\n"));
  }
  // Validate every generated key and payload before any irreversible upload.
  for (const run of runs) {
    run.key = `metric-stream/v1/${run.hour}/pulsar/epoch=${encodeURIComponent(run.epoch)}/topic=${encodeURIComponent(context.topic)}/first=${run.first}/last=${run.last}.jsonl.gz`;
    parseMetricStreamArchiveObjectKey(run.key);
  }
  for (const run of runs) {
    await context.assertActive();
    signal.throwIfAborted();
    const body = await compress(Buffer.concat(run.data));
    await context.assertActive();
    signal.throwIfAborted();
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
        { abortSignal: signal },
      );
    } catch (error) {
      if (!isCreateCollision(error)) throw error;
      await verifyCollision(client, bucket, run.key, body, signal);
    }
    await context.assertActive();
    signal.throwIfAborted();
  }
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
        archiveMetricStreamDeliveries(ownedStorage, bucket, context, controller.signal),
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
      ownedStorage = storage;
    const closing: Promise<unknown>[] = [];
    if (ownedNative) closing.push(Promise.resolve().then(() => ownedNative.close()));
    if (ownedStorage) closing.push(Promise.resolve().then(() => ownedStorage.destroy()));
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
