import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { constants, gzipSync } from "node:zlib";
import * as Sentry from "@sentry/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ArchivedMetricStreamEvent, readMetricStreamArchiveObject } from "./archive-reader.ts";

vi.mock("@sentry/node", () => ({ captureException: vi.fn() }));

const key =
  "metric-stream/v1/date=2026-11-03/hour=15/metric-stream-v1-0-9007199254740993-9007199254741999.jsonl.gz";
const row = {
  version: 1,
  id: "00000000-0000-4000-8000-000000000001",
  recordedAt: "2026-11-03T15:00:00.123456Z",
  userId: "00000000-0000-4000-8000-000000000002",
  providerId: "fixture",
  sourceType: "device",
  channel: "heart_rate",
  scalar: 120,
};
const limits = { maxCompressedBytes: 100_000, maxDecompressedBytes: 100_000, maxLineBytes: 10_000 };
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function input(
  bytes: Buffer,
  overrides: Partial<Parameters<typeof readMetricStreamArchiveObject>[0]> = {},
) {
  return {
    body: Readable.from([bytes]),
    objectKey: key,
    etag: '"opaque-etag"',
    expectedObjectVersion: { etag: '"opaque-etag"', contentSha256: digest(bytes) },
    limits,
    ...overrides,
  };
}

async function collect(value: Parameters<typeof readMetricStreamArchiveObject>[0]) {
  const records: ArchivedMetricStreamEvent[] = [];
  for await (const record of readMetricStreamArchiveObject(value)) records.push(record);
  return records;
}

afterEach(() => vi.clearAllMocks());

describe("readMetricStreamArchiveObject", () => {
  it("preserves original bytes, omitted generation, revisions and physical line provenance", async () => {
    const first = Buffer.from(`  ${JSON.stringify(row)} \r`);
    const second = Buffer.from(
      JSON.stringify({ ...row, version: 2, operationRevision: "900719925474099312345" }),
    );
    const bytes = gzipSync(Buffer.concat([Buffer.from("\n"), first, Buffer.from("\n\n"), second]));
    const result = await collect(input(bytes));
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      payload: first,
      event: { ...row, generation: 0 },
      objectKey: key,
      objectVersion: { etag: '"opaque-etag"', contentSha256: digest(bytes) },
      lineOrdinal: 2,
      payloadSha256: digest(first),
    });
    expect(result[1]).toMatchObject({
      payload: second,
      lineOrdinal: 4,
      event: { operationRevision: "900719925474099312345" },
    });
    expect(JSON.parse(result[0]?.payload.toString() ?? "{}")).not.toHaveProperty("generation");
  });

  it("reads delete and processing controls without recordedAt", async () => {
    const scope = { userId: row.userId };
    const events = [
      { version: 1, eventType: "metric_stream_deleted", scope, partitionKey: "account:fixture" },
      {
        version: 2,
        eventType: "metric_stream_deleted",
        scope,
        partitionKey: "account:fixture",
        eventId: row.id,
      },
      {
        version: 3,
        eventType: "metric_stream_deleted",
        scope,
        partitionKey: "account:fixture",
        eventId: row.id,
        operationRevision: "9007199254740993",
      },
      {
        version: 1,
        eventType: "metric_stream_batch_completed",
        operationId: row.id,
        batchId: "batch",
        datasetKeys: ["sensor"],
        expectedEventCount: 1,
        partitionKey: "processing:fixture",
      },
      {
        version: 1,
        eventType: "metric_stream_provider_generation_deleted",
        commandId: "9f4dca66-ed4b-5f1f-a287-fa15fed6709d",
        deletionEventId: "20000000-0000-4000-8000-000000000002",
        userId: "30000000-0000-4000-8000-000000000003",
        providerId: "garmin",
        generation: 2,
        sourceIds: [],
        complete: false,
        previousCommandId: null,
        partitionKey: "provider-generation:30000000-0000-4000-8000-000000000003:garmin",
      },
    ];
    const result = await collect(
      input(gzipSync(events.map((event) => JSON.stringify(event)).join("\n"))),
    );
    expect(result.map((record) => record.event)).toEqual(events);
  });

  it("accepts an empty gzip and counts blank physical lines without emitting events", async () => {
    expect(await collect(input(gzipSync("")))).toEqual([]);
    expect(await collect(input(gzipSync("\n\n")))).toEqual([]);
  });

  it("decodes UTF-8 spanning compressed and decompressed chunks without changing bytes", async () => {
    const payload = Buffer.from(JSON.stringify({ ...row, metadata: "é😀".repeat(3000) }));
    const bytes = gzipSync(payload);
    const result = await collect(
      input(bytes, {
        body: Readable.from(Array.from(bytes, (byte) => Buffer.from([byte]))),
        limits: { ...limits, maxLineBytes: 30_000 },
      }),
    );
    expect(result[0]?.payload).toEqual(payload);
    expect(result[0]?.event).toEqual({ ...row, generation: 0, metadata: "é😀".repeat(3000) });
  });

  it.each([
    [
      "invalid UTF-8",
      Buffer.concat([
        Buffer.from(JSON.stringify(row).slice(0, -1)),
        Buffer.from(',"metadata":"'),
        Buffer.from([0xff]),
        Buffer.from('"}'),
      ]),
      "Invalid UTF-8",
    ],
    ["malformed JSON", Buffer.from("{broken"), "Malformed JSON"],
    [
      "unsupported event",
      Buffer.from(JSON.stringify({ ...row, version: 99 })),
      "Unsupported event schema",
    ],
  ])(
    "rejects %s without exposing payloads or object identity to Sentry",
    async (_name, payload, message) => {
      const capture = vi.mocked(Sentry.captureException);
      await expect(collect(input(gzipSync(payload)))).rejects.toThrow(message);
      expect(capture).toHaveBeenCalledOnce();
      const reported = capture.mock.calls[0]?.[0];
      expect(reported).toBeInstanceOf(Error);
      expect(String(reported)).not.toContain(key);
      expect(String(reported)).not.toContain(row.userId);
    },
  );

  it("rejects changed ETags before reading source bytes", async () => {
    const bytes = gzipSync(JSON.stringify(row));
    let reads = 0;
    const body = new Readable({
      read() {
        reads += 1;
        this.push(bytes);
        this.push(null);
      },
    });
    await expect(collect(input(bytes, { body, etag: "changed" }))).rejects.toThrow("ETag mismatch");
    expect(reads).toBe(0);
    expect(body.destroyed).toBe(true);
  });

  it("checks the compressed digest at EOF after provisional records", async () => {
    const bytes = gzipSync(`${JSON.stringify(row)}\n`);
    const iterator = readMetricStreamArchiveObject(
      input(bytes, {
        expectedObjectVersion: { etag: '"opaque-etag"', contentSha256: "0".repeat(64) },
      }),
    )[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.event).toMatchObject(row);
    await expect(iterator.next()).rejects.toThrow("Content digest mismatch");
  });

  it("rejects a truncated gzip after a valid provisional line", async () => {
    const bytes = gzipSync(`${JSON.stringify(row)}\n`, { finishFlush: constants.Z_SYNC_FLUSH });
    const iterator = readMetricStreamArchiveObject(input(bytes))[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.event).toMatchObject(row);
    await expect(iterator.next()).rejects.toThrow("Compressed stream failed");
  });

  it.each([
    ["compressed", { ...limits, maxCompressedBytes: 1 }, "Compressed byte limit"],
    ["decompressed", { ...limits, maxDecompressedBytes: 1 }, "Decompressed byte limit"],
    ["line", { ...limits, maxLineBytes: 1 }, "Line byte limit"],
  ])("enforces the %s byte bound", async (_name, boundedLimits, message) => {
    const bytes = gzipSync(JSON.stringify(row));
    await expect(collect(input(bytes, { limits: boundedLimits }))).rejects.toThrow(message);
  });

  it("accepts exact byte limits and rejects cumulative overflow across gzip members", async () => {
    const payload = Buffer.from(`${JSON.stringify(row)}\n`);
    const member = gzipSync(payload);
    expect(
      await collect(
        input(member, {
          limits: {
            maxCompressedBytes: member.length,
            maxDecompressedBytes: payload.length,
            maxLineBytes: payload.length - 1,
          },
        }),
      ),
    ).toHaveLength(1);
    const bytes = Buffer.concat([member, member]);
    for (const boundedLimits of [
      { ...limits, maxCompressedBytes: bytes.length - 1 },
      { ...limits, maxDecompressedBytes: payload.length * 2 - 1 },
    ]) {
      await expect(
        collect(
          input(bytes, {
            body: Readable.from([member, member]),
            limits: boundedLimits,
          }),
        ),
      ).rejects.toThrow("byte limit exceeded");
    }
  });

  it("rejects a long line spanning decompressed chunks", async () => {
    const bytes = gzipSync(JSON.stringify({ ...row, metadata: "x".repeat(40_000) }));
    await expect(
      collect(input(bytes, { limits: { ...limits, maxLineBytes: 20_000 } })),
    ).rejects.toThrow("Line byte limit exceeded");
  });

  it("rejects invalid gzip and corruption after a complete member", async () => {
    await expect(collect(input(Buffer.from("invalid gzip")))).rejects.toThrow(
      "Compressed stream failed",
    );
    const bytes = Buffer.concat([
      gzipSync(`${JSON.stringify(row)}\n`),
      Buffer.from("invalid next member"),
    ]);
    await expect(collect(input(bytes))).rejects.toThrow("Compressed stream failed");
  });

  it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN, 1.5])(
    "rejects invalid finite limits: %s",
    async (maxLineBytes) => {
      await expect(
        collect(input(gzipSync(""), { limits: { ...limits, maxLineBytes } })),
      ).rejects.toThrow("positive safe integers");
    },
  );

  it("rejects malformed keys and missing version evidence", async () => {
    const bytes = gzipSync("");
    await expect(collect(input(bytes, { objectKey: "invalid" }))).rejects.toThrow(
      "Invalid archive key",
    );
    await expect(
      collect(input(bytes, { expectedObjectVersion: { etag: "", contentSha256: digest(bytes) } })),
    ).rejects.toThrow("Invalid object version");
  });

  it("destroys the source on early return without reading the whole object", async () => {
    const segment = gzipSync(`${JSON.stringify(row)}\n`);
    let generated = 0;
    const body = Readable.from(
      (function* () {
        for (let index = 0; index < 100_000; index += 1) {
          generated += 1;
          yield segment;
        }
      })(),
      { highWaterMark: 1 },
    );
    const iterator = readMetricStreamArchiveObject(
      input(segment, {
        body,
        limits: { ...limits, maxCompressedBytes: 100_000_000, maxDecompressedBytes: 100_000_000 },
      }),
    )[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    expect(body.destroyed).toBe(true);
    expect(generated).toBeLessThan(100_000);
  });

  it("surfaces source failures and destroys its source", async () => {
    const body = new Readable({
      read() {
        this.destroy(new Error("sensitive upstream failure"));
      },
    });
    await expect(collect(input(gzipSync(""), { body }))).rejects.toThrow(
      "Compressed stream failed",
    );
    expect(body.destroyed).toBe(true);
  });

  it("keeps the object's original provenance and stream ownership while yielding", async () => {
    const bytes = gzipSync(`${JSON.stringify(row)}\n${JSON.stringify(row)}\n`);
    const options = input(bytes);
    const originalBody = options.body;
    const replacementBody = new Readable({ read() {} });
    const iterator = readMetricStreamArchiveObject(options)[Symbol.asyncIterator]();
    try {
      expect((await iterator.next()).value?.objectKey).toBe(key);
      options.objectKey = "another-object";
      options.body = replacementBody;
      expect((await iterator.next()).value?.objectKey).toBe(key);
      expect((await iterator.next()).done).toBe(true);
      expect(originalBody.destroyed).toBe(true);
      expect(replacementBody.destroyed).toBe(false);
    } finally {
      await iterator.return?.();
      replacementBody.destroy();
    }
  });

  it("keeps its admitted finite line bound when the caller changes the supplied limits", async () => {
    const first = JSON.stringify(row);
    const second = JSON.stringify({ ...row, metadata: "x".repeat(1000) });
    const options = input(gzipSync(`${first}\n${second}\n`), {
      limits: { ...limits, maxLineBytes: Buffer.byteLength(first) },
    });
    const iterator = readMetricStreamArchiveObject(options)[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.payload.toString()).toBe(first);
    options.limits.maxLineBytes = Number.POSITIVE_INFINITY;
    await expect(iterator.next()).rejects.toThrow("Line byte limit exceeded");
    expect(options.body.destroyed).toBe(true);
  });
});
