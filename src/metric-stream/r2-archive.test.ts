import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import Pulsar, { type Consumer, type Message } from "pulsar-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyticsPosition } from "../analytics/test-helpers.ts";
import type {
  AccountErasureDeliveryFenceConnection,
  AccountErasureDeliveryFenceDatabase,
} from "../db/account-erasure-delivery-fence.ts";
import type { MetricStreamEventV2, MetricStreamRedpandaEvent } from "./events.ts";
import type { PulsarMetricStreamBatchContext } from "./pulsar-consumer.ts";
import { archiveMetricStreamDeliveries, startMetricStreamR2ArchiveFromEnv } from "./r2-archive.ts";
import { parseMetricStreamArchiveObjectKey } from "./r2-replay.ts";
import { sourceEvent } from "./test-helpers.ts";
import { metricStreamPosition } from "./transport-position.ts";

const runtime = vi.hoisted(() => ({
  storage: vi.fn(),
  native: vi.fn(),
  server: vi.fn(),
  capture: vi.fn(),
  database: vi.fn(),
}));
vi.mock("../r2-storage.ts", async (original) => ({
  ...(await original<typeof import("../r2-storage.ts")>()),
  createR2Client: runtime.storage,
}));
vi.mock("../db/index.ts", async (original) => ({
  ...(await original<typeof import("../db/index.ts")>()),
  createDatabaseFromEnv: runtime.database,
}));
vi.mock("../lib/error-reporting.ts", () => ({ captureException: runtime.capture }));
vi.mock("./consumer-readiness.ts", async (original) => ({
  ...(await original<typeof import("./consumer-readiness.ts")>()),
  createMetricStreamConsumerReadinessServer: runtime.server,
}));
vi.mock("pulsar-client", async (original) => {
  const actual = await original<
    typeof import("pulsar-client") & { default: typeof import("pulsar-client") }
  >();
  return { ...actual, default: { ...actual.default, Client: runtime.native } };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const stream = {
  transport: "pulsar" as const,
  epoch: "archive epoch",
  topic: "persistent://public/default/live",
  partition: -1,
};

const openUserId = "00000000-0000-4000-8000-000000000001";
const fencedUserId = "00000000-0000-4000-8000-000000000002";

function rowEvent(userId: string, id: string): MetricStreamEventV2 {
  return { ...sourceEvent, id, userId };
}

function encodeEvent(event: MetricStreamRedpandaEvent): Buffer {
  return Buffer.from(JSON.stringify(event));
}

function context(
  events: MetricStreamRedpandaEvent[] = [
    rowEvent(openUserId, "10000000-0000-4000-8000-000000000001"),
    rowEvent(openUserId, "10000000-0000-4000-8000-000000000002"),
  ],
  times: number[] = events.map(() => Date.UTC(2026, 10, 5, 10)),
  data?: Buffer[],
): { batch: PulsarMetricStreamBatchContext; events: MetricStreamRedpandaEvent[] } {
  const payloads = data ?? events.map(encodeEvent);
  if (payloads.length !== events.length && data === undefined) {
    throw new Error("fixture events and payloads must align");
  }
  const count = payloads.length;
  return {
    events: events.slice(0, count),
    batch: {
      topic: stream.topic,
      partition: -1,
      assertActive: async () => undefined,
      positions: payloads.map((_value, index) => analyticsPosition(stream, BigInt(index + 1))),
      deliveries: payloads.map((value, index) => ({
        data: value,
        key: "key",
        properties: {},
        publishTimestamp: times[index] ?? times[0] ?? 0,
      })),
    },
  };
}

function mockDatabase(fencedUserIds: readonly string[] = []): AccountErasureDeliveryFenceDatabase {
  return {
    async transaction(work) {
      const execute: AccountErasureDeliveryFenceConnection["execute"] = async (query) => {
        const text = JSON.stringify(query);
        if (text.includes("pg_advisory_xact_lock_shared")) return [];
        return fencedUserIds.map((user_id) => ({ user_id }));
      };
      return work({ execute });
    },
  };
}

function fixture(fencedUserIds: readonly string[] = []) {
  const client = new S3Client({
    region: "auto",
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
  });
  const send = vi.spyOn(client, "send").mockImplementation(async () => ({}));
  const database = mockDatabase(fencedUserIds);
  return {
    client,
    send,
    signal: new AbortController().signal,
    database,
  };
}

async function archive(
  archiveFixture: ReturnType<typeof fixture>,
  input: { batch: PulsarMetricStreamBatchContext; events: MetricStreamRedpandaEvent[] } = context(),
) {
  return archiveMetricStreamDeliveries(
    archiveFixture.client,
    "archive",
    input.batch,
    archiveFixture.database,
    archiveFixture.signal,
  );
}

describe("native JSONL archive", () => {
  it("allows crash redelivery to regroup into overlapping create-only archive objects", async () => {
    const archiveFixture = fixture();
    const batch = context();
    await archive(archiveFixture, batch);
    for (const index of [0, 1]) {
      await archive(archiveFixture, {
        events: batch.events.slice(index, index + 1),
        batch: {
          ...batch.batch,
          positions: batch.batch.positions.slice(index, index + 1),
          deliveries: batch.batch.deliveries.slice(index, index + 1),
        },
      });
    }
    const uploads = archiveFixture.send.mock.calls.map(([command]) => {
      if (!(command instanceof PutObjectCommand) || !Buffer.isBuffer(command.input.Body))
        throw new Error("Invalid upload fixture");
      return { key: command.input.Key, raw: gunzipSync(command.input.Body) };
    });
    expect(new Set(uploads.map((upload) => upload.key)).size).toBe(3);
    expect(Buffer.concat(uploads.slice(1).map((upload) => upload.raw))).toEqual(uploads[0]?.raw);
  });

  it("rejects an invalid later payload before uploading an earlier valid hour", async () => {
    const archiveFixture = fixture();
    const valid = rowEvent(openUserId, "10000000-0000-4000-8000-000000000001");
    await expect(
      archive(
        archiveFixture,
        context(
          [valid, valid],
          [Date.UTC(2026, 10, 5, 10), Date.UTC(2026, 10, 5, 11)],
          [encodeEvent(valid), Buffer.from("{}\n")],
        ),
      ),
    ).rejects.toThrow(/line|parseable/i);
    expect(archiveFixture.send).not.toHaveBeenCalled();
  });

  it("rejects a group beyond the application byte bound before upload", async () => {
    const archiveFixture = fixture();
    const events = Array.from({ length: 10 }, (_value, index) =>
      rowEvent(openUserId, `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
    );
    await expect(
      archive(
        archiveFixture,
        context(
          events,
          events.map(() => Date.UTC(2026, 10, 5, 10)),
          events.map(() => Buffer.alloc(900000, 32)),
        ),
      ),
    ).rejects.toThrow("8MiB");
    expect(archiveFixture.send).not.toHaveBeenCalled();
  });

  it("fails closed when delivery bytes are not a metric-stream event", async () => {
    const archiveFixture = fixture();
    await expect(
      archive(
        archiveFixture,
        context(
          [rowEvent(openUserId, "10000000-0000-4000-8000-000000000001")],
          [Date.UTC(2026, 10, 5, 10)],
          [Buffer.from('{"original":1}')],
        ),
      ),
    ).rejects.toThrow(/parseable/i);
    expect(archiveFixture.send).not.toHaveBeenCalled();
  });

  it("omits fenced account rows while preserving original range key provenance", async () => {
    const archiveFixture = fixture([fencedUserId]);
    const open = rowEvent(openUserId, "10000000-0000-4000-8000-000000000001");
    const closed = rowEvent(fencedUserId, "10000000-0000-4000-8000-000000000002");
    const input = context([open, closed]);
    await archive(archiveFixture, input);
    expect(archiveFixture.send).toHaveBeenCalledTimes(1);
    const command = archiveFixture.send.mock.calls[0]?.[0];
    if (
      !(command instanceof PutObjectCommand) ||
      !Buffer.isBuffer(command.input.Body) ||
      !command.input.Key
    )
      throw new Error("Invalid upload fixture");
    expect(gunzipSync(command.input.Body)).toEqual(
      Buffer.concat([encodeEvent(open), Buffer.from("\n")]),
    );
    expect(parseMetricStreamArchiveObjectKey(command.input.Key)).toMatchObject({
      firstHex: Buffer.from(
        input.batch.positions[0]?.transport === "pulsar"
          ? input.batch.positions[0].serializedMessageId
          : "",
        "base64",
      ).toString("hex"),
      lastHex: Buffer.from(
        input.batch.positions[1]?.transport === "pulsar"
          ? input.batch.positions[1].serializedMessageId
          : "",
        "base64",
      ).toString("hex"),
    });
  });

  it("skips PUT and succeeds when every delivery is fenced", async () => {
    const archiveFixture = fixture([fencedUserId]);
    await expect(
      archive(
        archiveFixture,
        context([
          rowEvent(fencedUserId, "10000000-0000-4000-8000-000000000001"),
          rowEvent(fencedUserId, "10000000-0000-4000-8000-000000000002"),
        ]),
      ),
    ).resolves.toBeUndefined();
    expect(archiveFixture.send).not.toHaveBeenCalled();
  });

  it("rejects ownerless delete controls before PUT on the native subscription", async () => {
    const archiveFixture = fixture([fencedUserId]);
    const ownerlessDelete: MetricStreamRedpandaEvent = {
      version: 2,
      eventType: "metric_stream_deleted",
      eventId: "10000000-0000-4000-8000-000000000099",
      scope: { activityId: "20000000-0000-4000-8000-000000000099" },
      partitionKey: "activity:20000000-0000-4000-8000-000000000099",
    };
    await expect(archive(archiveFixture, context([ownerlessDelete]))).rejects.toThrow(
      /rejects ownerless delete/i,
    );
    expect(archiveFixture.send).not.toHaveBeenCalled();
  });

  it("rejects legacy ownerless batch_completed markers before PUT", async () => {
    const archiveFixture = fixture();
    const ownerlessMarker: MetricStreamRedpandaEvent = {
      version: 1,
      eventType: "metric_stream_batch_completed",
      operationId: "30000000-0000-4000-8000-000000000001",
      batchId: "batch-1",
      datasetKeys: ["recovery"],
      expectedEventCount: 1,
      partitionKey: "processing:30000000-0000-4000-8000-000000000001:batch-1",
    };
    await expect(archive(archiveFixture, context([ownerlessMarker]))).rejects.toThrow(
      /rejects ownerless batch_completed/i,
    );
    expect(archiveFixture.send).not.toHaveBeenCalled();
  });

  it("fences v2 batch_completed markers by concrete account owner", async () => {
    const archiveFixture = fixture([fencedUserId]);
    const marker: MetricStreamRedpandaEvent = {
      version: 2,
      eventType: "metric_stream_batch_completed",
      operationId: "30000000-0000-4000-8000-000000000001",
      userId: fencedUserId,
      batchId: "batch-1",
      datasetKeys: ["recovery"],
      expectedEventCount: 1,
      partitionKey: "processing:30000000-0000-4000-8000-000000000001:batch-1",
    };
    await expect(archive(archiveFixture, context([marker]))).resolves.toBeUndefined();
    expect(archiveFixture.send).not.toHaveBeenCalled();
  });

  it("holds the delivery fence transaction through compress and PUT", async () => {
    const archiveFixture = fixture();
    const order: string[] = [];
    const database: AccountErasureDeliveryFenceDatabase = {
      async transaction(work) {
        order.push("transaction");
        const execute: AccountErasureDeliveryFenceConnection["execute"] = async (query) => {
          const text = JSON.stringify(query);
          if (text.includes("pg_advisory_xact_lock_shared")) {
            order.push("lock");
            return [];
          }
          order.push("fence-query");
          return [];
        };
        const result = await work({ execute });
        order.push("release");
        return result;
      },
    };
    archiveFixture.send.mockImplementation(async () => {
      order.push("put");
      return {};
    });
    await archiveMetricStreamDeliveries(
      archiveFixture.client,
      "archive",
      context().batch,
      database,
      archiveFixture.signal,
    );
    expect(order).toEqual(["transaction", "lock", "fence-query", "put", "release"]);
  });

  it("fails a collision read whose response closes before EOF", async () => {
    const archiveFixture = fixture();
    const body = new Readable({
      read() {
        this.destroy();
      },
    });
    archiveFixture.send
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 412 } })
      .mockImplementationOnce(async () => ({ Body: body }));
    await expect(archive(archiveFixture)).rejects.toThrow();
    expect(archiveFixture.send.mock.calls[1]?.[0]).toBeInstanceOf(GetObjectCommand);
  });

  it.each([
    null,
    "upload failed",
    {},
    { $metadata: null },
    { $metadata: 12 },
    { $metadata: {} },
    { $metadata: { httpStatusCode: 500 } },
  ])("rethrows non-412 upload failures without reading collision content (%j)", async (failure) => {
    const archiveFixture = fixture();
    archiveFixture.send.mockRejectedValueOnce(failure);
    await expect(archive(archiveFixture)).rejects.toBe(failure);
    expect(archiveFixture.send).toHaveBeenCalledTimes(1);
  });

  it("preserves real serialized batch identity in both key endpoints", async () => {
    const archiveFixture = fixture();
    const input = context();
    const positions = [3, 4].map((index) =>
      metricStreamPosition(
        stream,
        Pulsar.MessageId.deserialize(Buffer.from([8, 10, 16, 42, 32, index])),
      ),
    );
    await archive(archiveFixture, {
      ...input,
      batch: { ...input.batch, positions },
    });
    const command = archiveFixture.send.mock.calls[0]?.[0];
    if (!(command instanceof PutObjectCommand) || !command.input.Key)
      throw new Error("Native batch upload missing");
    expect(parseMetricStreamArchiveObjectKey(command.input.Key)).toMatchObject({
      firstHex: Buffer.from(positions[0]?.serializedMessageId ?? "", "base64").toString("hex"),
      lastHex: Buffer.from(positions[1]?.serializedMessageId ?? "", "base64").toString("hex"),
    });
  });

  it.each([NaN, Infinity, -1])(
    "rejects invalid native publish time %s before upload",
    async (timestamp) => {
      const archiveFixture = fixture();
      await expect(
        archive(archiveFixture, context(undefined, [timestamp, timestamp])),
      ).rejects.toThrow(/publish timestamp/);
      expect(archiveFixture.send).not.toHaveBeenCalled();
    },
  );

  it("preserves exact original bytes, gzip JSONL and real native endpoints", async () => {
    const archiveFixture = fixture();
    const input = context();
    await archive(archiveFixture, input);
    const command = archiveFixture.send.mock.calls[0]?.[0];
    if (
      !(command instanceof PutObjectCommand) ||
      !Buffer.isBuffer(command.input.Body) ||
      !command.input.Key
    )
      throw new Error("Invalid upload fixture");
    expect(gunzipSync(command.input.Body)).toEqual(
      Buffer.concat(input.batch.deliveries.flatMap(({ data }) => [data, Buffer.from("\n")])),
    );
  });

  it("splits contiguous UTC publish hours without using payload event dates", async () => {
    const archiveFixture = fixture();
    await archive(
      archiveFixture,
      context(undefined, [Date.UTC(2026, 10, 5, 23), Date.UTC(2026, 10, 6, 0)]),
    );
    expect(archiveFixture.send).toHaveBeenCalledTimes(2);
    expect(
      archiveFixture.send.mock.calls.map(
        ([command]) => command instanceof PutObjectCommand && command.input.Key,
      ),
    ).toEqual([
      expect.stringContaining("date=2026-11-05/hour=23"),
      expect.stringContaining("date=2026-11-06/hour=00"),
    ]);
  });

  it.each([
    Buffer.from([0xff]),
    Buffer.from('{"a":1}\n'),
    Buffer.from('{"a":1}\r'),
    Buffer.alloc(900001, 32),
  ])("rejects invalid original bytes before any upload", async (data) => {
    const archiveFixture = fixture();
    await expect(
      archive(
        archiveFixture,
        context(
          [rowEvent(openUserId, "10000000-0000-4000-8000-000000000001")],
          [Date.UTC(2026, 10, 5, 10)],
          [data],
        ),
      ),
    ).rejects.toThrow(/UTF|line|900000|payload|parseable/i);
    expect(archiveFixture.send).not.toHaveBeenCalled();
  });

  it("accepts only identical complete gzip bytes after a create-only collision", async () => {
    const archiveFixture = fixture();
    await archive(archiveFixture);
    const original = archiveFixture.send.mock.calls[0]?.[0];
    if (!(original instanceof PutObjectCommand) || !Buffer.isBuffer(original.input.Body))
      throw new Error("Invalid gzip fixture");
    archiveFixture.send
      .mockReset()
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 412 } })
      .mockImplementationOnce(async () => ({ Body: Readable.from([original.input.Body]) }));
    await expect(archive(archiveFixture)).resolves.toBeUndefined();
    expect(archiveFixture.send.mock.calls[1]?.[0]).toBeInstanceOf(GetObjectCommand);
  });

  it("accepts a before-activation mixed object after fencing by filtering retained lines under the held fence", async () => {
    const open = rowEvent(openUserId, "10000000-0000-4000-8000-000000000001");
    const closed = rowEvent(fencedUserId, "10000000-0000-4000-8000-000000000002");
    const input = context([closed, open]);
    const beforeActivation = gzipSync(
      Buffer.concat([encodeEvent(closed), Buffer.from("\n"), encodeEvent(open), Buffer.from("\n")]),
    );
    const assertActive = vi.fn(async () => undefined);
    const archiveFixture = fixture([fencedUserId]);
    archiveFixture.send
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 412 } })
      .mockImplementationOnce(async () => ({
        Body: Readable.from([beforeActivation]),
        ContentLength: beforeActivation.length,
      }));
    await expect(
      archive(archiveFixture, {
        events: input.events,
        batch: { ...input.batch, assertActive },
      }),
    ).resolves.toBeUndefined();
    expect(archiveFixture.send.mock.calls[0]?.[0]).toBeInstanceOf(PutObjectCommand);
    expect(archiveFixture.send.mock.calls[1]?.[0]).toBeInstanceOf(GetObjectCommand);
    expect(archiveFixture.send).toHaveBeenCalledTimes(2);
    expect(assertActive).toHaveBeenCalled();
  });

  it("rejects collision content whose retained B differs after fencing A", async () => {
    const open = rowEvent(openUserId, "10000000-0000-4000-8000-000000000001");
    const closed = rowEvent(fencedUserId, "10000000-0000-4000-8000-000000000002");
    const differentOpen = rowEvent(openUserId, "10000000-0000-4000-8000-000000000099");
    const input = context([closed, open]);
    const existing = gzipSync(
      Buffer.concat([
        encodeEvent(closed),
        Buffer.from("\n"),
        encodeEvent(differentOpen),
        Buffer.from("\n"),
      ]),
    );
    const archiveFixture = fixture([fencedUserId]);
    archiveFixture.send
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 412 } })
      .mockImplementationOnce(async () => ({
        Body: Readable.from([existing]),
        ContentLength: existing.length,
      }));
    await expect(archive(archiveFixture, input)).rejects.toThrow(
      /differs from the expected retained/i,
    );
    expect(archiveFixture.send).toHaveBeenCalledTimes(2);
  });

  it.each([
    { label: "non-gzip bytes", body: Buffer.from("different") },
    { label: "empty object", body: Buffer.alloc(0) },
  ])("rejects malformed collision content without overwriting ($label)", async ({ body }) => {
    const archiveFixture = fixture();
    archiveFixture.send
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 412 } })
      .mockImplementationOnce(async () => ({
        Body: Readable.from([body]),
        ContentLength: body.length,
      }));
    await expect(archive(archiveFixture)).rejects.toThrow(
      /collision|gzip|bound|newline|unparseable|content/i,
    );
    expect(archiveFixture.send).toHaveBeenCalledTimes(2);
  });

  it("rejects gzip bombs via stock maxOutputLength without allocating past the decompressed ceiling", async () => {
    // Highly compressible input stays under the compressed ceiling but expands past
    // MAX_DECOMPRESSED_ARCHIVE_BYTES; zlib maxOutputLength must fail closed.
    const bomb = gzipSync(Buffer.alloc(32 * 1024 * 1024, 0));
    expect(bomb.length).toBeLessThan(8 * 1024 * 1024);
    const archiveFixture = fixture();
    archiveFixture.send
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 412 } })
      .mockImplementationOnce(async () => ({
        Body: Readable.from([bomb]),
        ContentLength: bomb.length,
      }));
    await expect(archive(archiveFixture)).rejects.toThrow(/decompressed size bound/i);
    expect(archiveFixture.send).toHaveBeenCalledTimes(2);
  });

  it("accepts a near-limit collision whose gzip wrapper exceeds the bare decompressed ceiling", async () => {
    const maxGroup = 8 * 1024 * 1024;
    const maxPayload = 900_000;
    const maxDecompressed = maxGroup + 500;
    const gzipOverhead =
      (maxDecompressed >> 12) + (maxDecompressed >> 14) + (maxDecompressed >> 25) + 13 + 18;
    const events: MetricStreamEventV2[] = [];
    let payloadTotal = 0;
    let index = 0;
    while (events.length < 500 && payloadTotal < maxGroup) {
      const id = `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      const base = rowEvent(openUserId, id);
      const empty = encodeEvent({ ...base, metadata: { blob: "" } });
      const room = Math.min(maxPayload - empty.length - 2, maxGroup - payloadTotal - empty.length);
      if (room < 1024) break;
      const blob = randomBytes(Math.min(room, 256_000)).toString("base64").slice(0, room);
      const event = { ...base, metadata: { blob } };
      const encoded = encodeEvent(event);
      if (encoded.length > maxPayload || payloadTotal + encoded.length > maxGroup) break;
      events.push(event);
      payloadTotal += encoded.length;
      index += 1;
    }
    const jsonl = Buffer.concat(events.flatMap((event) => [encodeEvent(event), Buffer.from("\n")]));
    expect(jsonl.length).toBeGreaterThan(maxGroup - maxPayload);
    expect(jsonl.length).toBeLessThanOrEqual(maxDecompressed);
    // level 0 = Z_NO_COMPRESSION stored blocks: wrapper exceeds bare decompressed ceiling.
    // https://nodejs.org/api/zlib.html#zlibconstants
    const compressed = gzipSync(jsonl, { level: 0 });
    expect(compressed.length).toBeGreaterThan(maxDecompressed);
    expect(compressed.length).toBeLessThanOrEqual(maxDecompressed + gzipOverhead);
    const input = context(events);
    const archiveFixture = fixture();
    archiveFixture.send
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 412 } })
      .mockImplementationOnce(async () => ({
        Body: Readable.from([compressed]),
        ContentLength: compressed.length,
      }));
    await expect(archive(archiveFixture, input)).resolves.toBeUndefined();
    expect(archiveFixture.send).toHaveBeenCalledTimes(2);
  });

  it("rejects an empty delivery group before fence or upload", async () => {
    const archiveFixture = fixture();
    const input = context();
    await expect(
      archive(archiveFixture, {
        events: [],
        batch: { ...input.batch, deliveries: [], positions: [] },
      }),
    ).rejects.toThrow(/bounded group/i);
    expect(archiveFixture.send).not.toHaveBeenCalled();
  });

  it("rejects when positions do not align one-to-one with deliveries", async () => {
    const archiveFixture = fixture();
    const input = context();
    await expect(
      archive(archiveFixture, {
        events: input.events,
        batch: {
          ...input.batch,
          positions: input.batch.positions.slice(0, 1),
        },
      }),
    ).rejects.toThrow(/bounded group|position/i);
    expect(archiveFixture.send).not.toHaveBeenCalled();
  });

  it("rejects more than 500 deliveries before fence or upload", async () => {
    const archiveFixture = fixture();
    const input = context();
    const deliveries = Array.from({ length: 501 }, () => ({
      data: Buffer.from("x"),
      key: "key",
      properties: {},
      publishTimestamp: Date.UTC(2026, 10, 5, 10),
    }));
    const positions = Array.from({ length: 501 }, (_value, index) =>
      analyticsPosition(stream, BigInt(index + 1)),
    );
    await expect(
      archive(archiveFixture, {
        events: input.events,
        batch: { ...input.batch, deliveries, positions },
      }),
    ).rejects.toThrow(/bounded group/i);
    expect(archiveFixture.send).not.toHaveBeenCalled();
  });

  it("rejects a position for a different topic than the batch", async () => {
    const archiveFixture = fixture();
    const input = context();
    const wrongTopic = analyticsPosition(
      { ...stream, topic: "persistent://public/default/other" },
      1n,
    );
    await expect(
      archive(archiveFixture, {
        events: input.events,
        batch: {
          ...input.batch,
          positions: [wrongTopic, ...input.batch.positions.slice(1)],
        },
      }),
    ).rejects.toThrow(/original native position/i);
    expect(archiveFixture.send).not.toHaveBeenCalled();
  });

  it("rejects a group that crosses native transport epochs within one hour", async () => {
    const archiveFixture = fixture();
    const input = context();
    const first = input.batch.positions[0];
    if (!first) throw new Error("fixture position missing");
    const second = analyticsPosition({ ...stream, epoch: "other-epoch" }, 2n);
    await expect(
      archive(archiveFixture, {
        events: input.events,
        batch: {
          ...input.batch,
          positions: [first, second],
        },
      }),
    ).rejects.toThrow(/transport epochs/i);
    expect(archiveFixture.send).not.toHaveBeenCalled();
  });

  it("rejects publish timestamps above the safe integer date bound", async () => {
    const archiveFixture = fixture();
    await expect(
      archive(archiveFixture, context(undefined, [8_640_000_000_000_001, 8_640_000_000_000_001])),
    ).rejects.toThrow(/publish timestamp/);
    expect(archiveFixture.send).not.toHaveBeenCalled();
  });

  it("rejects collision ContentLength above the compressed ceiling before reading the body", async () => {
    const archiveFixture = fixture();
    archiveFixture.send
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 412 } })
      .mockImplementationOnce(async () => ({
        Body: Readable.from([gzipSync(Buffer.from("x\n"))]),
        ContentLength: 100_000_000,
      }));
    await expect(archive(archiveFixture)).rejects.toThrow(/compressed size bound/i);
    expect(archiveFixture.send).toHaveBeenCalledTimes(2);
  });

  it("rejects a collision response body that is not a Readable stream", async () => {
    const archiveFixture = fixture();
    archiveFixture.send
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 412 } })
      .mockImplementationOnce(async () => ({
        Body: Buffer.from("not-a-stream"),
        ContentLength: 12,
      }));
    await expect(archive(archiveFixture)).rejects.toThrow(/readable body/i);
  });

  it("rejects collision body chunks that are not bytes", async () => {
    const archiveFixture = fixture();
    archiveFixture.send
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 412 } })
      .mockImplementationOnce(async () => ({
        Body: Readable.from(["not-bytes"]),
        ContentLength: 9,
      }));
    await expect(archive(archiveFixture)).rejects.toThrow(/non-byte chunk/i);
  });

  it("fails closed when the process abort signal is already aborted before upload", async () => {
    const archiveFixture = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      archiveMetricStreamDeliveries(
        archiveFixture.client,
        "archive",
        context().batch,
        archiveFixture.database,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(archiveFixture.send).not.toHaveBeenCalled();
  });

  it("stops before a later hour when the earlier upload fails", async () => {
    const archiveFixture = fixture();
    archiveFixture.send.mockRejectedValue(new Error("upload uncertain"));
    await expect(
      archive(
        archiveFixture,
        context(undefined, [Date.UTC(2026, 10, 5, 23), Date.UTC(2026, 10, 6, 0)]),
      ),
    ).rejects.toThrow("upload uncertain");
    expect(archiveFixture.send).toHaveBeenCalledTimes(1);
  });

  it("awaits uploads and fails visibly on uncertain upload errors", async () => {
    const archiveFixture = fixture();
    archiveFixture.send.mockRejectedValue(new Error("upload uncertain"));
    await expect(archive(archiveFixture)).rejects.toThrow("upload uncertain");
  });
});

describe("archive runtime ownership", () => {
  let signals: EventEmitter;
  let server: EventEmitter & {
    listening: boolean;
    listen: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    vi.clearAllMocks();
    for (const [name, value] of Object.entries({
      PULSAR_SERVICE_URL: "pulsar://fixture:6650",
      METRIC_STREAM_TOPIC: stream.topic,
      METRIC_STREAM_TRANSPORT_EPOCH: stream.epoch,
      METRIC_STREAM_SUBSCRIPTION: "archive-fixture",
      METRIC_STREAM_R2_BUCKET: "archive",
      DATABASE_URL: "postgres://unit:unit@localhost/unit",
    }))
      vi.stubEnv(name, value);
    signals = new EventEmitter();
    vi.spyOn(process, "once").mockImplementation((name, listener) => {
      signals.once(name, listener);
      return process;
    });
    vi.spyOn(process, "off").mockImplementation((name, listener) => {
      signals.off(name, listener);
      return process;
    });
    server = Object.assign(new EventEmitter(), {
      listening: false,
      listen: vi.fn(),
      close: vi.fn(),
      unref: vi.fn(),
    });
    server.listen.mockImplementation(() => {
      server.listening = true;
      queueMicrotask(() => server.emit("listening"));
      return server;
    });
    server.close.mockImplementation((callback: (error?: Error) => void) => {
      server.listening = false;
      callback();
      return server;
    });
    runtime.server.mockReturnValue(server);
  });

  function intake(archiveFixture: ReturnType<typeof fixture>) {
    const consumer = {
      batchReceive: vi.fn<Consumer["batchReceive"]>(),
      acknowledge: vi.fn<Consumer["acknowledge"]>(),
      isConnected: () => true,
      close: vi.fn().mockResolvedValue(null),
    };
    const position = analyticsPosition(stream, 1n);
    const message = {
      getData: () => Buffer.from(JSON.stringify(sourceEvent)),
      getPartitionKey: () => "key",
      getProperties: () => ({}),
      getPublishTimestamp: () => Date.UTC(2026, 10, 5, 10),
      getTopicName: () => stream.topic,
      getMessageId: () =>
        Pulsar.MessageId.deserialize(Buffer.from(position.serializedMessageId, "base64")),
      getEventTimestamp: () => 0,
      getRedeliveryCount: () => 0,
      getOrderingKey: () => "",
      getProducerName: () => "fixture",
      isReplicated: () => false,
      getReplicatedFrom: () => "",
      getEncryptionContext: () => null,
    } satisfies Message;
    consumer.batchReceive.mockResolvedValueOnce([message]).mockResolvedValue([]);
    consumer.acknowledge.mockImplementation(async () => {
      signals.emit("SIGTERM");
      return null;
    });
    const native = {
      subscribe: vi.fn().mockResolvedValue(consumer),
      close: vi.fn().mockResolvedValue(null),
    };
    runtime.native.mockImplementation(function archiveNativeClient() {
      return native;
    });
    runtime.storage.mockReturnValue(archiveFixture.client);
    runtime.database.mockReturnValue({
      ...archiveFixture.database,
      $client: { end: vi.fn(async () => undefined) },
    });
    return { consumer, native };
  }

  it("awaits durable upload before ACK and closes all owned resources after intake", async () => {
    const archiveFixture = fixture();
    const { consumer, native } = intake(archiveFixture);
    const trace: string[] = [];
    archiveFixture.send.mockImplementation(async () => {
      trace.push("put");
      expect(consumer.acknowledge).not.toHaveBeenCalled();
      return {};
    });
    consumer.acknowledge.mockImplementation(async () => {
      trace.push("ack");
      signals.emit("SIGTERM");
      return null;
    });
    const destroy = vi.spyOn(archiveFixture.client, "destroy");
    await startMetricStreamR2ArchiveFromEnv();
    expect(trace).toEqual(["put", "ack"]);
    expect(consumer.close).toHaveBeenCalledOnce();
    expect(native.close).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
  });

  it("does not ACK an uncertain upload and reports failure after cleanup", async () => {
    const archiveFixture = fixture();
    const { consumer, native } = intake(archiveFixture);
    archiveFixture.send.mockRejectedValue(new Error("uncertain put"));
    await expect(startMetricStreamR2ArchiveFromEnv()).rejects.toThrow("uncertain put");
    expect(consumer.acknowledge).not.toHaveBeenCalled();
    expect(native.close).toHaveBeenCalledOnce();
    expect(runtime.capture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: {
          metricStreamConsumer: "r2-archive",
          metricStreamFailure: "runtime",
        },
      }),
    );
    expect(process.once).toHaveBeenCalledWith("SIGINT", expect.any(Function));
  });

  it.each([
    "PULSAR_SERVICE_URL",
    "METRIC_STREAM_TOPIC",
    "METRIC_STREAM_TRANSPORT_EPOCH",
    "METRIC_STREAM_SUBSCRIPTION",
    "METRIC_STREAM_R2_BUCKET",
  ])("fails before resource creation when %s is missing", async (name) => {
    vi.stubEnv(name, "");
    await expect(startMetricStreamR2ArchiveFromEnv()).rejects.toThrow(name);
    expect(runtime.native).not.toHaveBeenCalled();
    expect(runtime.storage).not.toHaveBeenCalled();
  });

  it.each([
    "metric-stream-live-v1",
    // Interior newline survives requiredEnvironment trim; trailing CR/LF would not.
    "persistent://public/default/li\nve",
    "persistent://public/live",
  ])("rejects METRIC_STREAM_TOPIC %j before native subscribe", async (topic) => {
    vi.stubEnv("METRIC_STREAM_TOPIC", topic);
    await expect(startMetricStreamR2ArchiveFromEnv()).rejects.toThrow(/persistent Pulsar topic/i);
    expect(runtime.native).not.toHaveBeenCalled();
  });

  it("settles native, storage and readiness cleanup when native close fails", async () => {
    const archiveFixture = fixture();
    const { native } = intake(archiveFixture);
    native.close.mockRejectedValue(new Error("native close failed"));
    const destroy = vi.spyOn(archiveFixture.client, "destroy");
    await expect(startMetricStreamR2ArchiveFromEnv()).rejects.toThrow("cleanup");
    expect(destroy).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
    expect(runtime.capture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: {
          metricStreamConsumer: "r2-archive",
          metricStreamFailure: "cleanup",
        },
      }),
    );
  });

  it("marks readiness unavailable before cleaning up an aborted intake", async () => {
    const archiveFixture = fixture();
    const { native } = intake(archiveFixture);
    native.close.mockImplementation(async () => {
      expect(runtime.server.mock.calls[0]?.[0].getStatus()).toBe("unavailable");
      return null;
    });
    await startMetricStreamR2ArchiveFromEnv();
  });

  it("closes acquired storage when native client construction fails", async () => {
    const archiveFixture = fixture();
    intake(archiveFixture);
    const destroy = vi.spyOn(archiveFixture.client, "destroy");
    runtime.native.mockImplementation(function failedArchiveNativeClient() {
      throw new Error("native initialization failed");
    });
    await expect(startMetricStreamR2ArchiveFromEnv()).rejects.toThrow(
      "native initialization failed",
    );
    expect(destroy).toHaveBeenCalledOnce();
  });
});
