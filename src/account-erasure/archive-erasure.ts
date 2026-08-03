import { createHash } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  type S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import * as Sentry from "@sentry/node";
import {
  isMetricStreamBatchCompletedEvent,
  isMetricStreamDeletedEvent,
  metricStreamRedpandaEventSchema,
} from "../metric-stream/events.ts";
import { parseMetricStreamArchiveObjectKey } from "../metric-stream/r2-replay.ts";

const ARCHIVE_PREFIX = "metric-stream/v1/";
const MAX_ARCHIVE_LIST_PAGES = 10_000;
const MULTIPART_PART_BYTES = 8 * 1024 * 1024;

export interface MetricStreamArchiveMetadata {
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  contentType?: string;
  expires?: Date;
  metadata: Readonly<Record<string, string>>;
}

export interface MetricStreamArchiveObject extends MetricStreamArchiveMetadata {
  body: Readable;
  etag: string;
}

export interface MetricStreamArchiveStorage {
  abortMultipart(key: string, uploadId: string): Promise<void>;
  completeMultipart(
    key: string,
    uploadId: string,
    parts: readonly { etag: string; partNumber: number }[],
  ): Promise<string>;
  commitStagedObject(
    stagingKey: string,
    targetKey: string,
    stagingEtag: string,
    expectedTargetEtag: string,
  ): Promise<void>;
  createMultipart(key: string, metadata: MetricStreamArchiveMetadata): Promise<string>;
  deleteObject(key: string): Promise<void>;
  getObject(key: string): Promise<MetricStreamArchiveObject>;
  listObjectKeys(startAfter?: string): AsyncIterable<string>;
  uploadPart(key: string, uploadId: string, partNumber: number, body: Buffer): Promise<string>;
}

export class R2MetricStreamArchiveStorage implements MetricStreamArchiveStorage {
  readonly #bucket: string;
  readonly #client: S3Client;

  constructor(client: S3Client, bucket: string) {
    this.#client = client;
    this.#bucket = bucket;
  }

  async *listObjectKeys(startAfter?: string): AsyncIterable<string> {
    let continuationToken: string | undefined;
    let pagesInspected = 0;
    const seenContinuationTokens = new Set<string>();
    do {
      pagesInspected += 1;
      if (pagesInspected > MAX_ARCHIVE_LIST_PAGES) {
        throw new Error("R2 archive listing exceeded the bounded page limit");
      }
      const response = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          ContinuationToken: continuationToken,
          Prefix: ARCHIVE_PREFIX,
          StartAfter: continuationToken ? undefined : startAfter,
        }),
      );
      for (const object of response.Contents ?? []) {
        if (object.Key) yield object.Key;
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
      if (response.IsTruncated && !continuationToken) {
        throw new Error("R2 archive listing was truncated without a continuation token");
      }
      if (continuationToken && seenContinuationTokens.has(continuationToken)) {
        throw new Error("R2 archive listing repeated a continuation token");
      }
      if (continuationToken) {
        seenContinuationTokens.add(continuationToken);
      }
    } while (continuationToken);
  }

  async getObject(key: string): Promise<MetricStreamArchiveObject> {
    const response = await this.#client.send(
      new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
    );
    if (!(response.Body instanceof Readable) || !response.ETag) {
      throw new Error(`R2 archive object ${key} is missing a readable body or ETag`);
    }
    return {
      body: response.Body,
      etag: response.ETag,
      ...(response.CacheControl ? { cacheControl: response.CacheControl } : {}),
      ...(response.ContentDisposition ? { contentDisposition: response.ContentDisposition } : {}),
      ...(response.ContentEncoding ? { contentEncoding: response.ContentEncoding } : {}),
      ...(response.ContentLanguage ? { contentLanguage: response.ContentLanguage } : {}),
      ...(response.ContentType ? { contentType: response.ContentType } : {}),
      ...(response.Expires ? { expires: response.Expires } : {}),
      metadata: response.Metadata ?? {},
    };
  }

  async createMultipart(key: string, metadata: MetricStreamArchiveMetadata): Promise<string> {
    const response = await this.#client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.#bucket,
        ...(metadata.cacheControl ? { CacheControl: metadata.cacheControl } : {}),
        ...(metadata.contentDisposition ? { ContentDisposition: metadata.contentDisposition } : {}),
        ...(metadata.contentEncoding ? { ContentEncoding: metadata.contentEncoding } : {}),
        ...(metadata.contentLanguage ? { ContentLanguage: metadata.contentLanguage } : {}),
        ...(metadata.contentType ? { ContentType: metadata.contentType } : {}),
        ...(metadata.expires ? { Expires: metadata.expires } : {}),
        Key: key,
        Metadata: { ...metadata.metadata },
      }),
    );
    if (!response.UploadId) {
      throw new Error(`R2 did not return a multipart upload ID for ${key}`);
    }
    return response.UploadId;
  }

  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ): Promise<string> {
    const response = await this.#client.send(
      new UploadPartCommand({
        Body: body,
        Bucket: this.#bucket,
        ContentLength: body.byteLength,
        Key: key,
        PartNumber: partNumber,
        UploadId: uploadId,
      }),
    );
    if (!response.ETag) {
      throw new Error(`R2 did not return an ETag for ${key} part ${partNumber}`);
    }
    return response.ETag;
  }

  async completeMultipart(
    key: string,
    uploadId: string,
    parts: readonly { etag: string; partNumber: number }[],
  ): Promise<string> {
    const response = await this.#client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.#bucket,
        Key: key,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            ETag: part.etag,
            PartNumber: part.partNumber,
          })),
        },
        UploadId: uploadId,
      }),
    );
    if (!response.ETag) {
      throw new Error(`R2 did not return an ETag after completing ${key}`);
    }
    return response.ETag;
  }

  async commitStagedObject(
    stagingKey: string,
    targetKey: string,
    stagingEtag: string,
    expectedTargetEtag: string,
  ): Promise<void> {
    const command = new CopyObjectCommand({
      Bucket: this.#bucket,
      CopySource: encodeURIComponent(`${this.#bucket}/${stagingKey}`),
      CopySourceIfMatch: stagingEtag,
      Key: targetKey,
    });
    command.middlewareStack.add(
      (next) => async (arguments_) => {
        const { request } = arguments_;
        if (
          request === null ||
          typeof request !== "object" ||
          !("headers" in request) ||
          typeof request.headers !== "object" ||
          request.headers === null
        ) {
          throw new Error("R2 CopyObject request is missing HTTP headers");
        }
        Object.assign(request.headers, {
          "cf-copy-destination-if-match": expectedTargetEtag,
        });
        return next(arguments_);
      },
      {
        name: "r2ConditionalDestinationCopy",
        priority: "low",
        step: "build",
      },
    );
    await this.#client.send(command);
  }

  async deleteObject(key: string): Promise<void> {
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.#client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.#bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }
}

export interface ArchiveErasureIdentifiers {
  activityIds: ReadonlySet<string>;
  operationIds: ReadonlySet<string>;
  userId: string;
}

export interface ArchiveErasureResult {
  lastKey: string | null;
  objectsRewritten: number;
  recordsRemoved: number;
}

function belongsToAccount(
  line: string,
  identifiers: ArchiveErasureIdentifiers,
  context: { key: string; lineNumber: number },
): boolean {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(line);
  } catch {
    throw new Error(
      `Malformed JSON in R2 archive object ${context.key} at line ${context.lineNumber}`,
    );
  }
  const parsedEvent = metricStreamRedpandaEventSchema.safeParse(parsedJson);
  if (!parsedEvent.success) {
    throw new Error(
      `Unsupported metric-stream event schema in ${context.key} at line ${context.lineNumber}`,
    );
  }
  const event = parsedEvent.data;
  if (isMetricStreamBatchCompletedEvent(event)) {
    return identifiers.operationIds.has(event.operationId);
  }
  if (isMetricStreamDeletedEvent(event)) {
    return (
      event.scope.userId === identifiers.userId ||
      (event.scope.activityId !== undefined && identifiers.activityIds.has(event.scope.activityId))
    );
  }
  return (
    event.userId === identifiers.userId ||
    (event.activityId !== null &&
      event.activityId !== undefined &&
      identifiers.activityIds.has(event.activityId))
  );
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === "string") return Buffer.from(chunk);
  throw new Error("Archive gzip stream emitted an unsupported chunk");
}

async function uploadCompressedParts(
  storage: MetricStreamArchiveStorage,
  key: string,
  uploadId: string,
  compressedStream: Readable,
): Promise<Array<{ etag: string; partNumber: number }>> {
  const parts: Array<{ etag: string; partNumber: number }> = [];
  let pending = Buffer.alloc(0);

  const upload = async (body: Buffer): Promise<void> => {
    const partNumber = parts.length + 1;
    const etag = await storage.uploadPart(key, uploadId, partNumber, body);
    parts.push({ etag, partNumber });
  };

  const chunks: AsyncIterable<unknown> = compressedStream;
  for await (const chunk of chunks) {
    const buffer = toBuffer(chunk);
    pending = Buffer.concat([pending, buffer]);
    while (pending.byteLength >= MULTIPART_PART_BYTES) {
      await upload(pending.subarray(0, MULTIPART_PART_BYTES));
      pending = pending.subarray(MULTIPART_PART_BYTES);
    }
  }
  if (pending.byteLength > 0) {
    await upload(pending);
  }
  if (parts.length === 0) {
    throw new Error(`Archive rewrite for ${key} produced no compressed parts`);
  }
  return parts;
}

async function writeLine(output: ReturnType<typeof createGzip>, line: string): Promise<void> {
  if (!output.write(`${line}\n`)) {
    await once(output, "drain");
  }
}

async function countMatchingArchiveRecords(
  body: Readable,
  identifiers: ArchiveErasureIdentifiers,
  key: string,
): Promise<number> {
  const gunzip = createGunzip();
  const sourcePipeline = pipeline(body, gunzip);
  let matches = 0;
  try {
    const lines = createInterface({ input: gunzip, crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber += 1;
      if (line.length > 0 && belongsToAccount(line, identifiers, { key, lineNumber })) {
        matches += 1;
      }
    }
    await sourcePipeline;
    return matches;
  } catch (error: unknown) {
    body.destroy();
    gunzip.destroy();
    await Promise.allSettled([sourcePipeline]);
    throw error;
  }
}

async function rewriteArchiveObject(
  storage: MetricStreamArchiveStorage,
  key: string,
  identifiers: ArchiveErasureIdentifiers,
): Promise<number> {
  parseMetricStreamArchiveObjectKey(key);
  const scannedObject = await storage.getObject(key);
  const matchingRecords = await countMatchingArchiveRecords(scannedObject.body, identifiers, key);
  if (matchingRecords === 0) return 0;

  const object = await storage.getObject(key);
  if (object.etag !== scannedObject.etag) {
    throw new Error(`R2 archive object ${key} changed during account erasure scan`);
  }
  const stagingKey = `account-erasure-staging/${createHash("sha256")
    .update(identifiers.userId)
    .update("\0")
    .update(key)
    .update("\0")
    .update(object.etag)
    .digest("hex")}.jsonl.gz`;
  const uploadId = await storage.createMultipart(stagingKey, object);
  const gunzip = createGunzip();
  const gzip = createGzip({ level: 9 });
  const uploadedParts = uploadCompressedParts(storage, stagingKey, uploadId, gzip);
  const sourcePipeline = pipeline(object.body, gunzip);
  const propagateUploadFailure = uploadedParts.catch((error: unknown) => {
    object.body.destroy(error instanceof Error ? error : undefined);
    gunzip.destroy(error instanceof Error ? error : undefined);
    gzip.destroy(error instanceof Error ? error : undefined);
  });
  const propagateSourceFailure = sourcePipeline.catch((error: unknown) => {
    gzip.destroy(error instanceof Error ? error : undefined);
  });
  let removed = 0;
  let multipartCompleted = false;

  try {
    const lines = createInterface({ input: gunzip, crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber += 1;
      if (line.length === 0) continue;
      if (belongsToAccount(line, identifiers, { key, lineNumber })) {
        removed += 1;
      } else {
        await writeLine(gzip, line);
      }
    }
    gzip.end();
    const [parts] = await Promise.all([uploadedParts, sourcePipeline]);
    if (removed !== matchingRecords) {
      throw new Error(`R2 archive object ${key} changed during account erasure rewrite`);
    }
    const stagingEtag = await storage.completeMultipart(stagingKey, uploadId, parts);
    multipartCompleted = true;
    await storage.commitStagedObject(stagingKey, key, stagingEtag, object.etag);
    await storage.deleteObject(stagingKey);
    return removed;
  } catch (error: unknown) {
    object.body.destroy(error instanceof Error ? error : undefined);
    gunzip.destroy();
    gzip.destroy();
    const failures: unknown[] = [error];
    const backgroundResults = await Promise.allSettled([
      uploadedParts,
      sourcePipeline,
      propagateUploadFailure,
      propagateSourceFailure,
    ]);
    for (const result of backgroundResults) {
      if (result.status === "rejected" && !failures.includes(result.reason)) {
        failures.push(result.reason);
      }
    }
    try {
      if (multipartCompleted) {
        await storage.deleteObject(stagingKey);
      } else {
        await storage.abortMultipart(stagingKey, uploadId);
      }
    } catch (cleanupError: unknown) {
      Sentry.captureException(cleanupError, {
        tags: {
          accountErasureStep: multipartCompleted
            ? "deleteArchiveStagingObject"
            : "abortArchiveMultipartUpload",
        },
      });
      failures.push(cleanupError);
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `R2 archive erasure failed and cleanup did not fully succeed for ${key}`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function eraseMetricStreamArchive(
  storage: MetricStreamArchiveStorage,
  identifiers: ArchiveErasureIdentifiers,
  options: {
    onObjectCompleted?: (key: string) => Promise<void>;
    startAfter?: string;
  } = {},
): Promise<ArchiveErasureResult> {
  let lastKey: string | null = null;
  let objectsRewritten = 0;
  let recordsRemoved = 0;
  for await (const key of storage.listObjectKeys(options.startAfter)) {
    const removed = await rewriteArchiveObject(storage, key, identifiers);
    if (removed > 0) objectsRewritten += 1;
    recordsRemoved += removed;
    lastKey = key;
    await options.onObjectCompleted?.(key);
  }
  return { lastKey, objectsRewritten, recordsRemoved };
}
