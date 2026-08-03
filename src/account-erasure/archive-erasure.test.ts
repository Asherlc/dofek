import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";
import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import {
  createMetricStreamBatchCompletedEvent,
  createMetricStreamDeletedEvent,
} from "../metric-stream/events.ts";
import type { MetricStreamArchiveObject, MetricStreamArchiveStorage } from "./archive-erasure.ts";
import { eraseMetricStreamArchive, R2MetricStreamArchiveStorage } from "./archive-erasure.ts";

const deletingUserId = "10000000-0000-4000-8000-000000001994";
const otherUserId = "20000000-0000-4000-8000-000000001994";

class MemoryArchiveStorage implements MetricStreamArchiveStorage {
  readonly completedExpectedEtags: string[] = [];
  readonly completedPartSizes: number[][] = [];
  readonly getCounts = new Map<string, number>();
  readonly objects = new Map<string, Buffer>();
  readonly uploads = new Map<string, Buffer[]>();

  async *listObjectKeys(startAfter?: string): AsyncIterable<string> {
    for (const key of [...this.objects.keys()].sort()) {
      if (!startAfter || key > startAfter) yield key;
    }
  }

  async getObject(key: string): Promise<MetricStreamArchiveObject> {
    const body = this.objects.get(key);
    if (!body) throw new Error("missing object");
    this.getCounts.set(key, (this.getCounts.get(key) ?? 0) + 1);
    return { body: Readable.from(body), etag: '"original-etag"', metadata: {} };
  }

  async createMultipart(key: string): Promise<string> {
    this.uploads.set(key, []);
    return `upload:${key}`;
  }

  async uploadPart(
    key: string,
    _uploadId: string,
    _partNumber: number,
    body: Buffer,
  ): Promise<string> {
    this.uploads.get(key)?.push(body);
    return '"part-etag"';
  }

  async completeMultipart(
    key: string,
    _uploadId: string,
    _parts: readonly { etag: string; partNumber: number }[],
  ): Promise<string> {
    this.completedPartSizes.push((this.uploads.get(key) ?? []).map((part) => part.byteLength));
    this.objects.set(key, Buffer.concat(this.uploads.get(key) ?? []));
    return '"staging-etag"';
  }

  async commitStagedObject(
    stagingKey: string,
    targetKey: string,
    _stagingEtag: string,
    expectedTargetEtag: string,
  ): Promise<void> {
    this.completedExpectedEtags.push(expectedTargetEtag);
    const body = this.objects.get(stagingKey);
    if (!body) throw new Error("missing staging object");
    this.objects.set(targetKey, body);
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async abortMultipart(key: string): Promise<void> {
    this.uploads.delete(key);
  }
}

interface CapturedRequest {
  headers: Record<string, string>;
  method: string;
  path: string;
}

function isCapturedRequest(value: unknown): value is CapturedRequest {
  return (
    value !== null &&
    typeof value === "object" &&
    "headers" in value &&
    value.headers !== null &&
    typeof value.headers === "object" &&
    "method" in value &&
    typeof value.method === "string" &&
    "path" in value &&
    typeof value.path === "string"
  );
}

function makeR2Client(
  handler: (request: CapturedRequest) => Promise<{
    response: {
      body: Readable;
      headers: Record<string, string>;
      statusCode: number;
    };
  }>,
): S3Client {
  return new S3Client({
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    endpoint: "https://account.r2.cloudflarestorage.com",
    region: "auto",
    requestHandler: {
      destroy: vi.fn(),
      handle: (request: unknown) => {
        if (!isCapturedRequest(request)) {
          throw new Error("Unexpected AWS request shape");
        }
        return handler(request);
      },
      metadata: { handlerProtocol: "http/1.1" },
      updateHttpClientConfig: vi.fn(),
      httpHandlerConfigs: vi.fn(() => ({})),
    },
  });
}

function metricEvent(userId: string, id: string): Record<string, unknown> {
  return {
    version: 1,
    id,
    recordedAt: "2026-07-26T10:00:00.000Z",
    userId,
    providerId: "apple_health",
    generation: 0,
    sourceType: "api",
    channel: "heart_rate",
    scalar: 70,
  };
}

describe("eraseMetricStreamArchive", () => {
  it("conditionally rewrites a mixed-user gzip object without buffering the archive", async () => {
    const storage = new MemoryArchiveStorage();
    const key = "metric-stream/v1/date=2026-07-26/hour=10/metric-stream-v1-0-10-11.jsonl.gz";
    const deletingEvent = metricEvent(deletingUserId, "30000000-0000-4000-8000-000000001994");
    const preservedEvent = metricEvent(otherUserId, "40000000-0000-4000-8000-000000001994");
    storage.objects.set(
      key,
      gzipSync(`${JSON.stringify(deletingEvent)}\n${JSON.stringify(preservedEvent)}\n`),
    );

    const result = await eraseMetricStreamArchive(storage, {
      activityIds: new Set(),
      operationIds: new Set(),
      userId: deletingUserId,
    });

    expect(result).toEqual({
      lastKey: key,
      objectsRewritten: 1,
      recordsRemoved: 1,
    });
    expect(storage.completedExpectedEtags).toEqual(['"original-etag"']);
    expect(storage.getCounts.get(key)).toBe(2);
    expect(gunzipSync(storage.objects.get(key) ?? Buffer.alloc(0)).toString("utf8")).toBe(
      `${JSON.stringify(preservedEvent)}\n`,
    );
  });

  it("does not replace an object that contains no account data", async () => {
    const storage = new MemoryArchiveStorage();
    const key = "metric-stream/v1/date=2026-07-26/hour=10/metric-stream-v1-0-12-12.jsonl.gz";
    const original = gzipSync(
      `${JSON.stringify(metricEvent(otherUserId, "50000000-0000-4000-8000-000000001994"))}\n`,
    );
    storage.objects.set(key, original);

    await eraseMetricStreamArchive(storage, {
      activityIds: new Set(),
      operationIds: new Set(),
      userId: deletingUserId,
    });

    expect(storage.completedExpectedEtags).toEqual([]);
    expect(storage.getCounts.get(key)).toBe(1);
    expect(storage.objects.get(key)).toEqual(original);
  });

  it("removes matching batch, delete, user, and activity events", async () => {
    const storage = new MemoryArchiveStorage();
    const key = "metric-stream/v1/date=2026-07-26/hour=10/metric-stream-v1-0-12-12.jsonl.gz";
    const activityId = "30000000-0000-4000-8000-000000001994";
    const operationId = "40000000-0000-4000-8000-000000001994";
    const matchingBatch = createMetricStreamBatchCompletedEvent(
      { batchId: "batch-1994", datasetKeys: ["metric-stream"], operationId },
      1,
    );
    const otherBatch = createMetricStreamBatchCompletedEvent(
      {
        batchId: "other-batch-1994",
        datasetKeys: ["metric-stream"],
        operationId: "50000000-0000-4000-8000-000000001994",
      },
      1,
    );
    const matchingDelete = createMetricStreamDeletedEvent({ activityId }, "1");
    const matchingAccountDelete = createMetricStreamDeletedEvent({ userId: deletingUserId }, "1");
    const otherDelete = createMetricStreamDeletedEvent(
      {
        activityId: "60000000-0000-4000-8000-000000001994",
      },
      "1",
    );
    const matchingActivity = metricEvent(otherUserId, "70000000-0000-4000-8000-000000001994");
    matchingActivity.activityId = activityId;
    const nullActivity = metricEvent(otherUserId, "80000000-0000-4000-8000-000000001994");
    nullActivity.activityId = null;
    const original = [
      matchingBatch,
      otherBatch,
      matchingDelete,
      matchingAccountDelete,
      otherDelete,
      matchingActivity,
      nullActivity,
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    storage.objects.set(key, gzipSync(`${original}\n`));

    await expect(
      eraseMetricStreamArchive(storage, {
        activityIds: new Set([activityId]),
        operationIds: new Set([operationId]),
        userId: deletingUserId,
      }),
    ).resolves.toMatchObject({ recordsRemoved: 4, objectsRewritten: 1 });

    expect(gunzipSync(storage.objects.get(key) ?? Buffer.alloc(0)).toString("utf8")).toBe(
      `${JSON.stringify(otherBatch)}\n${JSON.stringify(otherDelete)}\n${JSON.stringify(nullActivity)}\n`,
    );
  });

  it("skips blank archive lines while rewriting", async () => {
    const storage = new MemoryArchiveStorage();
    const key = "metric-stream/v1/date=2026-07-26/hour=10/metric-stream-v1-0-16-16.jsonl.gz";
    const preservedEvent = metricEvent(otherUserId, "90000000-0000-4000-8000-000000001994");
    storage.objects.set(
      key,
      gzipSync(
        `\n${JSON.stringify(metricEvent(deletingUserId, "a0000000-0000-4000-8000-000000001994"))}\n\n${JSON.stringify(preservedEvent)}\n`,
      ),
    );

    await expect(
      eraseMetricStreamArchive(storage, {
        activityIds: new Set(),
        operationIds: new Set(),
        userId: deletingUserId,
      }),
    ).resolves.toMatchObject({ recordsRemoved: 1, objectsRewritten: 1 });
    expect(gunzipSync(storage.objects.get(key) ?? Buffer.alloc(0)).toString("utf8")).toBe(
      `${JSON.stringify(preservedEvent)}\n`,
    );
  });

  it("aborts a multipart rewrite when uploading a part fails", async () => {
    class UploadFailureStorage extends MemoryArchiveStorage {
      override async uploadPart(
        _key: string,
        _uploadId: string,
        _partNumber: number,
        _body: Buffer,
      ): Promise<string> {
        throw new Error("part upload failed");
      }
    }
    const storage = new UploadFailureStorage();
    const key = "metric-stream/v1/date=2026-07-26/hour=10/metric-stream-v1-0-17-17.jsonl.gz";
    storage.objects.set(
      key,
      gzipSync(
        `${JSON.stringify(metricEvent(deletingUserId, "b0000000-0000-4000-8000-000000001994"))}\n`,
      ),
    );

    await expect(
      eraseMetricStreamArchive(storage, {
        activityIds: new Set(),
        operationIds: new Set(),
        userId: deletingUserId,
      }),
    ).rejects.toThrow("part upload failed");
    expect(storage.uploads).toEqual(new Map());
  });

  it("aborts a multipart rewrite when completion fails", async () => {
    class CompletionFailureStorage extends MemoryArchiveStorage {
      override async completeMultipart(
        _key: string,
        _uploadId: string,
        _parts: readonly { etag: string; partNumber: number }[],
      ): Promise<string> {
        throw new Error("multipart completion failed");
      }
    }
    const storage = new CompletionFailureStorage();
    const key = "metric-stream/v1/date=2026-07-26/hour=10/metric-stream-v1-0-18-18.jsonl.gz";
    storage.objects.set(
      key,
      gzipSync(
        `${JSON.stringify(metricEvent(deletingUserId, "c0000000-0000-4000-8000-000000001994"))}\n`,
      ),
    );

    await expect(
      eraseMetricStreamArchive(storage, {
        activityIds: new Set(),
        operationIds: new Set(),
        userId: deletingUserId,
      }),
    ).rejects.toThrow("multipart completion failed");
    expect(storage.uploads).toEqual(new Map());
  });

  it("reports aggregate failure when staging cleanup also fails", async () => {
    class CleanupFailureStorage extends MemoryArchiveStorage {
      override async commitStagedObject(
        _stagingKey: string,
        _targetKey: string,
        _stagingEtag: string,
        _expectedTargetEtag: string,
      ): Promise<void> {
        throw new Error("conditional commit failed");
      }

      override async deleteObject(key: string): Promise<void> {
        if (key.startsWith("account-erasure-staging/")) {
          throw new Error("staging cleanup failed");
        }
        await super.deleteObject(key);
      }
    }
    const storage = new CleanupFailureStorage();
    const key = "metric-stream/v1/date=2026-07-26/hour=10/metric-stream-v1-0-19-19.jsonl.gz";
    storage.objects.set(
      key,
      gzipSync(
        `${JSON.stringify(metricEvent(deletingUserId, "d0000000-0000-4000-8000-000000001994"))}\n`,
      ),
    );

    await expect(
      eraseMetricStreamArchive(storage, {
        activityIds: new Set(),
        operationIds: new Set(),
        userId: deletingUserId,
      }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof AggregateError && error.message.includes("cleanup"),
    );
  });

  it("detects a source change during the rewrite even when its ETag is unchanged", async () => {
    class BodyRaceStorage extends MemoryArchiveStorage {
      reads = 0;

      override async getObject(_key: string): Promise<MetricStreamArchiveObject> {
        this.reads += 1;
        const body =
          this.reads === 1
            ? gzipSync(
                `${JSON.stringify(metricEvent(deletingUserId, "e0000000-0000-4000-8000-000000001994"))}\n`,
              )
            : gzipSync(
                `${JSON.stringify(metricEvent(otherUserId, "f0000000-0000-4000-8000-000000001994"))}\n`,
              );
        return { body: Readable.from(body), etag: '"same-etag"', metadata: {} };
      }
    }
    const storage = new BodyRaceStorage();
    const key = "metric-stream/v1/date=2026-07-26/hour=10/metric-stream-v1-0-20-20.jsonl.gz";
    storage.objects.set(key, Buffer.alloc(0));

    await expect(
      eraseMetricStreamArchive(storage, {
        activityIds: new Set(),
        operationIds: new Set(),
        userId: deletingUserId,
      }),
    ).rejects.toThrow("changed during account erasure rewrite");
  });

  it("fails closed without replacing an object that contains malformed JSON", async () => {
    const storage = new MemoryArchiveStorage();
    const key = "metric-stream/v1/date=2026-07-26/hour=10/metric-stream-v1-0-13-13.jsonl.gz";
    const original = gzipSync(`corrupt free text containing ${deletingUserId} as a substring\n`);
    storage.objects.set(key, original);

    await expect(
      eraseMetricStreamArchive(storage, {
        activityIds: new Set(),
        operationIds: new Set(),
        userId: deletingUserId,
      }),
    ).rejects.toThrow(`Malformed JSON in R2 archive object ${key} at line 1`);

    expect(storage.completedExpectedEtags).toEqual([]);
    expect(storage.uploads).toEqual(new Map());
    expect(storage.objects.get(key)).toEqual(original);
  });

  it("fails closed when an unrecognized event hides an account identifier in composite JSON", async () => {
    const storage = new MemoryArchiveStorage();
    const key = "metric-stream/v1/date=2026-07-26/hour=10/metric-stream-v1-0-14-14.jsonl.gz";
    const unrecognizedEvent = {
      eventType: "future_metric_stream_event",
      partitionKey: `account:${deletingUserId}`,
      version: 99,
      [`subject:${deletingUserId}`]: true,
    };
    const original = gzipSync(`${JSON.stringify(unrecognizedEvent)}\n`);
    storage.objects.set(key, original);

    await expect(
      eraseMetricStreamArchive(storage, {
        activityIds: new Set(),
        operationIds: new Set(),
        userId: deletingUserId,
      }),
    ).rejects.toThrow(`Unsupported metric-stream event schema in ${key} at line 1`);

    expect(storage.completedExpectedEtags).toEqual([]);
    expect(storage.uploads).toEqual(new Map());
    expect(storage.objects.get(key)).toEqual(original);
  });

  it("refuses to replace an object whose ETag changes after the scan", async () => {
    class RacingArchiveStorage extends MemoryArchiveStorage {
      override async getObject(key: string): Promise<MetricStreamArchiveObject> {
        const object = await super.getObject(key);
        return {
          ...object,
          etag: this.getCounts.get(key) === 1 ? '"first-etag"' : '"second-etag"',
        };
      }
    }
    const storage = new RacingArchiveStorage();
    const key = "metric-stream/v1/date=2026-07-26/hour=10/metric-stream-v1-0-14-14.jsonl.gz";
    storage.objects.set(
      key,
      gzipSync(
        `${JSON.stringify(metricEvent(deletingUserId, "60000000-0000-4000-8000-000000001994"))}\n`,
      ),
    );

    await expect(
      eraseMetricStreamArchive(storage, {
        activityIds: new Set(),
        operationIds: new Set(),
        userId: deletingUserId,
      }),
    ).rejects.toThrow("changed during account erasure scan");
    expect(storage.completedExpectedEtags).toEqual([]);
  });

  it("uploads equal-sized non-final parts for a large rewrite", async () => {
    const storage = new MemoryArchiveStorage();
    const key = "metric-stream/v1/date=2026-07-26/hour=10/metric-stream-v1-0-15-16.jsonl.gz";
    const preservedEvent = {
      ...metricEvent(otherUserId, "70000000-0000-4000-8000-000000001994"),
      metadata: {
        payload: randomBytes(18 * 1024 * 1024).toString("base64"),
      },
    };
    storage.objects.set(
      key,
      gzipSync(
        `${JSON.stringify(
          metricEvent(deletingUserId, "80000000-0000-4000-8000-000000001994"),
        )}\n${JSON.stringify(preservedEvent)}\n`,
      ),
    );

    await eraseMetricStreamArchive(storage, {
      activityIds: new Set(),
      operationIds: new Set(),
      userId: deletingUserId,
    });

    const [partSizes] = storage.completedPartSizes;
    expect(partSizes?.length).toBeGreaterThan(2);
    expect(partSizes?.slice(0, -1)).toEqual(
      Array.from({ length: (partSizes?.length ?? 1) - 1 }, () => 8 * 1024 * 1024),
    );
    expect(partSizes?.at(-1)).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});

describe("R2MetricStreamArchiveStorage conditional commit", () => {
  it("sends both source and destination ETag preconditions through the S3 client", async () => {
    const requests: CapturedRequest[] = [];
    const client = makeR2Client(async (request) => {
      requests.push(request);
      return {
        response: {
          body: Readable.from(
            '<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>&quot;copied&quot;</ETag><LastModified>2026-07-26T12:00:00.000Z</LastModified></CopyObjectResult>',
          ),
          headers: { "content-type": "application/xml" },
          statusCode: 200,
        },
      };
    });
    const storage = new R2MetricStreamArchiveStorage(client, "metric-archive");

    await storage.commitStagedObject(
      "account-erasure-staging/rewrite.jsonl.gz",
      "metric-stream/v1/date=2026-07-26/archive.jsonl.gz",
      '"staging-etag"',
      '"target-etag"',
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers["x-amz-copy-source-if-match"]).toBe('"staging-etag"');
    expect(requests[0]?.headers["cf-copy-destination-if-match"]).toBe('"target-etag"');
    expect(requests[0]?.headers["x-amz-metadata-directive"]).toBeUndefined();
    expect(requests[0]?.headers["content-encoding"]).toBeUndefined();
    expect(requests[0]?.headers["content-type"]).toBeUndefined();
    expect(requests[0]?.path).toContain("/metric-stream/v1/date%3D2026-07-26/archive.jsonl.gz");
  });

  it("leaves the destination intact on 412 and can retry the same key", async () => {
    const targetBodies = new Map([["archive-key", "original-body"]]);
    let attempts = 0;
    const client = makeR2Client(async (request) => {
      attempts += 1;
      if (attempts === 1) {
        return {
          response: {
            body: Readable.from(
              '<?xml version="1.0" encoding="UTF-8"?><Error><Code>PreconditionFailed</Code><Message>destination changed</Message></Error>',
            ),
            headers: { "content-type": "application/xml" },
            statusCode: 412,
          },
        };
      }
      expect(request.path).toContain("/archive-key");
      targetBodies.set("archive-key", "rewritten-body");
      return {
        response: {
          body: Readable.from(
            '<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>&quot;copied&quot;</ETag><LastModified>2026-07-26T12:00:00.000Z</LastModified></CopyObjectResult>',
          ),
          headers: { "content-type": "application/xml" },
          statusCode: 200,
        },
      };
    });
    const storage = new R2MetricStreamArchiveStorage(client, "metric-archive");

    await expect(
      storage.commitStagedObject(
        "staging-key",
        "archive-key",
        '"staging-etag"',
        '"stale-target-etag"',
      ),
    ).rejects.toThrow();
    expect(targetBodies.get("archive-key")).toBe("original-body");

    await expect(
      storage.commitStagedObject(
        "staging-key",
        "archive-key",
        '"staging-etag"',
        '"current-target-etag"',
      ),
    ).resolves.toBeUndefined();
    expect(targetBodies.get("archive-key")).toBe("rewritten-body");
    expect(attempts).toBe(2);
  });
});

describe("R2MetricStreamArchiveStorage metadata", () => {
  it("reads the original content headers and every custom metadata field", async () => {
    const client = makeR2Client(async () => ({
      response: {
        body: Readable.from("compressed-body"),
        headers: {
          "cache-control": "private, max-age=600",
          "content-disposition": 'attachment; filename="archive.jsonl.gz"',
          "content-encoding": "gzip",
          "content-language": "en-US",
          "content-type": "application/vnd.dofek.metric-stream+jsonl",
          etag: '"source-etag"',
          expires: "Tue, 28 Jul 2026 12:00:00 GMT",
          "x-amz-meta-archive-generation": "7",
          "x-amz-meta-source-cluster": "redpanda-production",
        },
        statusCode: 200,
      },
    }));
    const storage = new R2MetricStreamArchiveStorage(client, "metric-archive");

    await expect(storage.getObject("metric-stream/v1/archive.jsonl.gz")).resolves.toMatchObject({
      cacheControl: "private, max-age=600",
      contentDisposition: 'attachment; filename="archive.jsonl.gz"',
      contentEncoding: "gzip",
      contentLanguage: "en-US",
      contentType: "application/vnd.dofek.metric-stream+jsonl",
      etag: '"source-etag"',
      expires: new Date("2026-07-28T12:00:00.000Z"),
      metadata: {
        "archive-generation": "7",
        "source-cluster": "redpanda-production",
      },
    });
  });

  it("creates the staging multipart upload with the original content headers and metadata", async () => {
    const requests: CapturedRequest[] = [];
    const client = makeR2Client(async (request) => {
      requests.push(request);
      return {
        response: {
          body: Readable.from(
            '<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>metric-archive</Bucket><Key>staging-key</Key><UploadId>upload-1994</UploadId></InitiateMultipartUploadResult>',
          ),
          headers: { "content-type": "application/xml" },
          statusCode: 200,
        },
      };
    });
    const storage = new R2MetricStreamArchiveStorage(client, "metric-archive");

    await storage.createMultipart("staging-key", {
      cacheControl: "private, max-age=600",
      contentDisposition: 'attachment; filename="archive.jsonl.gz"',
      contentEncoding: "gzip",
      contentLanguage: "en-US",
      contentType: "application/vnd.dofek.metric-stream+jsonl",
      expires: new Date("2026-07-28T12:00:00.000Z"),
      metadata: {
        "archive-generation": "7",
        "source-cluster": "redpanda-production",
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers["cache-control"]).toBe("private, max-age=600");
    expect(requests[0]?.headers["content-disposition"]).toBe(
      'attachment; filename="archive.jsonl.gz"',
    );
    expect(requests[0]?.headers["content-encoding"]).toBe("gzip");
    expect(requests[0]?.headers["content-language"]).toBe("en-US");
    expect(requests[0]?.headers["content-type"]).toBe("application/vnd.dofek.metric-stream+jsonl");
    expect(requests[0]?.headers.expires).toBe("Tue, 28 Jul 2026 12:00:00 GMT");
    expect(requests[0]?.headers["x-amz-meta-archive-generation"]).toBe("7");
    expect(requests[0]?.headers["x-amz-meta-source-cluster"]).toBe("redpanda-production");
  });

  it("reads and validates object metadata", async () => {
    const client = makeR2Client(async () => ({
      response: {
        body: Readable.from("body"),
        headers: { "content-type": "application/xml" },
        statusCode: 200,
      },
    }));
    const storage = new R2MetricStreamArchiveStorage(client, "metric-archive");

    await expect(storage.getObject("missing-evidence")).rejects.toThrow(
      "is missing a readable body or ETag",
    );
  });

  it("uploads, completes, deletes, and aborts multipart objects", async () => {
    const requests: CapturedRequest[] = [];
    const client = makeR2Client(
      async (
        request,
      ): Promise<{
        response: { body: Readable; headers: Record<string, string>; statusCode: number };
      }> => {
        requests.push(request);
        if (request.method === "PUT") {
          return {
            response: {
              body: Readable.from(""),
              headers: { etag: '"part-etag"' },
              statusCode: 200,
            },
          };
        }
        if (request.method === "POST") {
          return {
            response: {
              body: Readable.from(
                "<CompleteMultipartUploadResult><ETag>&quot;complete-etag&quot;</ETag></CompleteMultipartUploadResult>",
              ),
              headers: { "content-type": "application/xml" },
              statusCode: 200,
            },
          };
        }
        return {
          response: {
            body: Readable.from(""),
            headers: {},
            statusCode: 204,
          },
        };
      },
    );
    const storage = new R2MetricStreamArchiveStorage(client, "metric-archive");

    await expect(
      storage.uploadPart("staging-key", "upload-id", 2, Buffer.from("part")),
    ).resolves.toBe('"part-etag"');
    await expect(
      storage.completeMultipart("staging-key", "upload-id", [
        { etag: '"part-etag"', partNumber: 2 },
      ]),
    ).resolves.toBe('"complete-etag"');
    await expect(storage.deleteObject("staging-key")).resolves.toBeUndefined();
    await expect(storage.abortMultipart("staging-key", "upload-id")).resolves.toBeUndefined();
    expect(requests).toHaveLength(4);
  });

  it.each([
    [
      "createMultipart",
      async (storage: R2MetricStreamArchiveStorage) =>
        storage.createMultipart("key", { metadata: {} }),
    ],
    [
      "uploadPart",
      async (storage: R2MetricStreamArchiveStorage) =>
        storage.uploadPart("key", "upload", 1, Buffer.from("body")),
    ],
    [
      "completeMultipart",
      async (storage: R2MetricStreamArchiveStorage) =>
        storage.completeMultipart("key", "upload", []),
    ],
  ])("rejects a missing ETag or upload ID from %s", async (_name, operation) => {
    const storage = new R2MetricStreamArchiveStorage(
      makeR2Client(async () => ({
        response: {
          body: Readable.from("<Response />"),
          headers: { "content-type": "application/xml" },
          statusCode: 200,
        },
      })),
      "metric-archive",
    );

    await expect(operation(storage)).rejects.toThrow();
  });
});

describe("R2MetricStreamArchiveStorage listing", () => {
  it("lists archive keys across pages and resumes after a key", async () => {
    let requests = 0;
    const client = makeR2Client(async () => {
      requests += 1;
      const body =
        requests === 1
          ? '<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>page-2</NextContinuationToken><Contents><Key>metric-stream/v1/a</Key></Contents><Contents><Key></Key></Contents></ListBucketResult>'
          : '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>metric-stream/v1/b</Key></Contents></ListBucketResult>';
      return {
        response: {
          body: Readable.from(body),
          headers: { "content-type": "application/xml" },
          statusCode: 200,
        },
      };
    });
    const storage = new R2MetricStreamArchiveStorage(client, "metric-archive");
    const keys: string[] = [];
    for await (const key of storage.listObjectKeys("metric-stream/v1/previous")) {
      keys.push(key);
    }

    expect(keys).toEqual(["metric-stream/v1/a", "metric-stream/v1/b"]);
    expect(requests).toBe(2);
  });
  it("fails closed when R2 repeats a continuation token", async () => {
    let requests = 0;
    const client = makeR2Client(async () => {
      requests += 1;
      if (requests > 2) {
        throw new Error("Archive listing issued an unbounded third request");
      }
      return {
        response: {
          body: Readable.from(
            '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>metric-archive</Name><Prefix>metric-stream/v1/</Prefix><KeyCount>0</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>true</IsTruncated><NextContinuationToken>repeat</NextContinuationToken></ListBucketResult>',
          ),
          headers: { "content-type": "application/xml" },
          statusCode: 200,
        },
      };
    });
    const storage = new R2MetricStreamArchiveStorage(client, "metric-archive");

    await expect(async () => {
      for await (const _key of storage.listObjectKeys()) {
        // The fixture intentionally has no objects.
      }
    }).rejects.toThrow("R2 archive listing repeated a continuation token");
    expect(requests).toBe(2);
  });

  it("fails closed when R2 truncates a listing without a continuation token", async () => {
    const client = makeR2Client(async () => ({
      response: {
        body: Readable.from(
          '<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>metric-stream/v1/a</Key></Contents></ListBucketResult>',
        ),
        headers: { "content-type": "application/xml" },
        statusCode: 200,
      },
    }));
    const storage = new R2MetricStreamArchiveStorage(client, "metric-archive");

    await expect(async () => {
      for await (const _key of storage.listObjectKeys()) {
        // The fixture is intentionally truncated without a continuation token.
      }
    }).rejects.toThrow("R2 archive listing was truncated without a continuation token");
  });

  it("fails closed when an archive listing exceeds the bounded page limit", async () => {
    let requests = 0;
    const client = makeR2Client(async () => {
      requests += 1;
      const isTruncated = requests <= 10_000;
      return {
        response: {
          body: Readable.from(
            `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>metric-archive</Name><Prefix>metric-stream/v1/</Prefix><KeyCount>0</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>${isTruncated}</IsTruncated>${
              isTruncated ? `<NextContinuationToken>page-${requests}</NextContinuationToken>` : ""
            }</ListBucketResult>`,
          ),
          headers: { "content-type": "application/xml" },
          statusCode: 200,
        },
      };
    });
    const storage = new R2MetricStreamArchiveStorage(client, "metric-archive");

    await expect(async () => {
      for await (const _key of storage.listObjectKeys()) {
        // The fixture intentionally has no objects.
      }
    }).rejects.toThrow("R2 archive listing exceeded the bounded page limit");
    expect(requests).toBe(10_000);
  });
});
