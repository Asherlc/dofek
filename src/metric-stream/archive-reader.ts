import { createHash } from "node:crypto";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import * as Sentry from "@sentry/node";
import { type MetricStreamRedpandaEvent, metricStreamRedpandaEventSchema } from "./events.ts";
import { parseMetricStreamArchiveObjectKey } from "./r2-replay.ts";

export interface MetricStreamArchiveObjectVersion {
  etag: string;
  /** SHA-256 of the exact compressed source object, independent of its opaque ETag. */
  contentSha256: string;
}

export interface ArchivedMetricStreamEvent {
  payload: Buffer;
  event: MetricStreamRedpandaEvent;
  objectKey: string;
  objectVersion: MetricStreamArchiveObjectVersion;
  lineOrdinal: number;
  payloadSha256: string;
}

export interface MetricStreamArchiveReadInput {
  body: Readable;
  objectKey: string;
  etag: string;
  expectedObjectVersion: MetricStreamArchiveObjectVersion;
  limits: {
    maxCompressedBytes: number;
    maxDecompressedBytes: number;
    maxLineBytes: number;
  };
}

class ArchiveReadError extends Error {}

/**
 * Takes ownership of body and destroys all owned streams on failure or cancellation.
 * Every yielded record is PROVISIONAL: the sealed compressed digest and gzip
 * integrity are verified only after successful full EOF. Early return is never
 * object verification. Payload bytes exclude only the JSONL newline delimiter;
 * parsed defaults are not written back. Physical ordinals are one-based and are
 * never recovered Kafka offsets.
 */
export async function* readMetricStreamArchiveObject(
  input: MetricStreamArchiveReadInput,
): AsyncIterable<ArchivedMetricStreamEvent> {
  const { body, objectKey, etag } = input;
  const limits = { ...input.limits };
  let compressedBytes = 0;
  let decompressedBytes = 0;
  let lineOrdinal = 0;
  const contentHash = createHash("sha256");
  const gunzip = createGunzip();
  const compressedCounter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      compressedBytes += chunk.byteLength;
      if (compressedBytes > limits.maxCompressedBytes) {
        callback(new ArchiveReadError("Compressed byte limit exceeded"));
        return;
      }
      contentHash.update(chunk);
      callback(null, chunk);
    },
  });
  let sourceResult: Promise<{ error?: unknown }> | undefined;
  try {
    if (Object.values(limits).some((limit) => !Number.isSafeInteger(limit) || limit <= 0)) {
      throw new ArchiveReadError("Archive byte limits must be positive safe integers");
    }
    const objectVersion = { ...input.expectedObjectVersion };
    if (!objectVersion.etag || !/^[a-f0-9]{64}$/.test(objectVersion.contentSha256)) {
      throw new ArchiveReadError("Invalid object version evidence");
    }
    if (etag !== objectVersion.etag) throw new ArchiveReadError("ETag mismatch");
    // The shared parser's error contains the caller's key, so do not propagate it.
    try {
      parseMetricStreamArchiveObjectKey(objectKey);
    } catch {
      throw new ArchiveReadError("Invalid archive key");
    }

    sourceResult = pipeline(body, compressedCounter, gunzip).then(
      () => ({}),
      (error: unknown) => ({ error }),
    );
    const parts: Buffer[] = [];
    let lineBytes = 0;
    const append = (part: Buffer) => {
      lineBytes += part.byteLength;
      if (lineBytes > limits.maxLineBytes) {
        throw new ArchiveReadError(`Line byte limit exceeded at line ${lineOrdinal + 1}`);
      }
      if (part.byteLength) parts.push(part);
    };
    const decodeLine = (): ArchivedMetricStreamEvent | null => {
      lineOrdinal += 1;
      if (lineBytes === 0) return null;
      const payload = Buffer.concat(parts, lineBytes);
      parts.length = 0;
      lineBytes = 0;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(payload);
      } catch {
        throw new ArchiveReadError(`Invalid UTF-8 at line ${lineOrdinal}`);
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ArchiveReadError(`Malformed JSON at line ${lineOrdinal}`);
      }
      const parsed = metricStreamRedpandaEventSchema.safeParse(json);
      if (!parsed.success) {
        throw new ArchiveReadError(`Unsupported event schema at line ${lineOrdinal}`);
      }
      return {
        payload,
        event: parsed.data,
        objectKey,
        objectVersion: { ...objectVersion },
        lineOrdinal,
        payloadSha256: createHash("sha256").update(payload).digest("hex"),
      };
    };
    for await (const chunk of gunzip) {
      const bytes: Buffer = chunk;
      decompressedBytes += bytes.byteLength;
      if (decompressedBytes > limits.maxDecompressedBytes) {
        throw new ArchiveReadError("Decompressed byte limit exceeded");
      }
      let start = 0;
      for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
        append(bytes.subarray(start, end));
        const record = decodeLine();
        if (record) yield record;
        start = end + 1;
      }
      append(bytes.subarray(start));
    }
    const result = await sourceResult;
    if (result.error) throw result.error;
    if (lineBytes) {
      const record = decodeLine();
      if (record) yield record;
    }
    if (contentHash.digest("hex") !== objectVersion.contentSha256) {
      throw new ArchiveReadError("Content digest mismatch");
    }
  } catch (error: unknown) {
    const sanitized =
      error instanceof ArchiveReadError ? error : new ArchiveReadError("Compressed stream failed");
    Sentry.captureException(sanitized);
    throw sanitized;
  } finally {
    body.destroy();
    compressedCounter.destroy();
    gunzip.destroy();
    await sourceResult;
  }
}
