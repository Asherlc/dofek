import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import Pulsar, { type Consumer, type Message } from "pulsar-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyticsPosition } from "../analytics/test-helpers.ts";
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
}));
vi.mock("../r2-storage.ts", async (original) => ({
  ...(await original<typeof import("../r2-storage.ts")>()),
  createR2Client: runtime.storage,
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
function context(
  data = [Buffer.from(' {"original": 1} '), Buffer.from('{"original":2}')],
  times = [Date.UTC(2026, 10, 5, 10), Date.UTC(2026, 10, 5, 10)],
): PulsarMetricStreamBatchContext {
  return {
    topic: stream.topic,
    partition: -1,
    assertActive: async () => undefined,
    positions: data.map((_value, index) => analyticsPosition(stream, BigInt(index + 1))),
    deliveries: data.map((value, index) => ({
      data: value,
      key: "key",
      properties: {},
      publishTimestamp: times[index] ?? 0,
    })),
  };
}
function fixture() {
  const client = new S3Client({
    region: "auto",
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
  });
  const send = vi.spyOn(client, "send").mockImplementation(async () => ({}));
  return { client, send, signal: new AbortController().signal };
}
describe("native JSONL archive", () => {
  it("allows crash redelivery to regroup into overlapping create-only archive objects", async () => {
    const archive = fixture(),
      batch = context();
    await archiveMetricStreamDeliveries(archive.client, "archive", batch, archive.signal);
    for (const index of [0, 1])
      await archiveMetricStreamDeliveries(
        archive.client,
        "archive",
        {
          ...batch,
          positions: batch.positions.slice(index, index + 1),
          deliveries: batch.deliveries.slice(index, index + 1),
        },
        archive.signal,
      );
    const uploads = archive.send.mock.calls.map(([command]) => {
      if (!(command instanceof PutObjectCommand) || !Buffer.isBuffer(command.input.Body))
        throw new Error("Invalid upload fixture");
      return { key: command.input.Key, raw: gunzipSync(command.input.Body) };
    });
    expect(new Set(uploads.map((upload) => upload.key)).size).toBe(3);
    expect(Buffer.concat(uploads.slice(1).map((upload) => upload.raw))).toEqual(uploads[0]?.raw);
    expect(
      uploads.every(
        (upload) =>
          upload.key && parseMetricStreamArchiveObjectKey(upload.key).topic === stream.topic,
      ),
    ).toBe(true);
  });
  it("rejects an invalid later payload before uploading an earlier valid hour", async () => {
    const archive = fixture();
    await expect(
      archiveMetricStreamDeliveries(
        archive.client,
        "archive",
        context(
          [Buffer.from("{}"), Buffer.from("{}\n")],
          [Date.UTC(2026, 10, 5, 10), Date.UTC(2026, 10, 5, 11)],
        ),
        archive.signal,
      ),
    ).rejects.toThrow(/line/i);
    expect(archive.send).not.toHaveBeenCalled();
  });
  it("rejects a group beyond the application byte bound before upload", async () => {
    const archive = fixture();
    await expect(
      archiveMetricStreamDeliveries(
        archive.client,
        "archive",
        context(Array.from({ length: 10 }, () => Buffer.alloc(900000, 32))),
        archive.signal,
      ),
    ).rejects.toThrow("8MiB");
    expect(archive.send).not.toHaveBeenCalled();
  });
  it("fails a collision read whose response closes before EOF", async () => {
    const archive = fixture(),
      body = new Readable({
        read() {
          this.destroy();
        },
      });
    archive.send
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 412 } })
      .mockImplementationOnce(async () => ({ Body: body }));
    await expect(
      archiveMetricStreamDeliveries(archive.client, "archive", context(), archive.signal),
    ).rejects.toThrow();
  });
  it("preserves real serialized batch identity in both key endpoints", async () => {
    const archive = fixture(),
      batch = context();
    const positions = [3, 4].map((index) =>
      metricStreamPosition(
        stream,
        Pulsar.MessageId.deserialize(Buffer.from([8, 10, 16, 42, 32, index])),
      ),
    );
    await archiveMetricStreamDeliveries(
      archive.client,
      "archive",
      { ...batch, positions },
      archive.signal,
    );
    const command = archive.send.mock.calls[0]?.[0];
    if (!(command instanceof PutObjectCommand) || !command.input.Key)
      throw new Error("Native batch upload missing");
    expect(parseMetricStreamArchiveObjectKey(command.input.Key)).toMatchObject({
      firstHex: Buffer.from(positions[0]?.serializedMessageId ?? "", "base64").toString("hex"),
      lastHex: Buffer.from(positions[1]?.serializedMessageId ?? "", "base64").toString("hex"),
    });
    expect(positions.map((position) => position.delivery.batch)).toEqual([3, 4]);
  });
  it.each([NaN, Infinity, -1])(
    "rejects invalid native publish time %s before upload",
    async (timestamp) => {
      const archive = fixture();
      await expect(
        archiveMetricStreamDeliveries(
          archive.client,
          "archive",
          context(undefined, [timestamp, timestamp]),
          archive.signal,
        ),
      ).rejects.toThrow(/publish timestamp/);
      expect(archive.send).not.toHaveBeenCalled();
    },
  );
  it("preserves exact original bytes, gzip JSONL and real native endpoints", async () => {
    const archive = fixture(),
      batch = context();
    await archiveMetricStreamDeliveries(archive.client, "archive", batch, archive.signal);
    expect(archive.send).toHaveBeenCalledTimes(1);
    const command = archive.send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    if (
      !(command instanceof PutObjectCommand) ||
      !Buffer.isBuffer(command.input.Body) ||
      !command.input.Key
    )
      throw new Error("Invalid upload fixture");
    expect(command.input).toMatchObject({
      Bucket: "archive",
      IfNoneMatch: "*",
      ContentEncoding: "gzip",
      ContentType: "application/x-ndjson",
    });
    expect(gunzipSync(command.input.Body)).toEqual(
      Buffer.concat(batch.deliveries.flatMap(({ data }) => [data, Buffer.from("\n")])),
    );
    expect(parseMetricStreamArchiveObjectKey(command.input.Key)).toEqual({
      transport: "pulsar",
      date: "2026-11-05",
      hour: "10",
      epoch: stream.epoch,
      topic: stream.topic,
      firstHex: Buffer.from(
        batch.positions[0]?.transport === "pulsar" ? batch.positions[0].serializedMessageId : "",
        "base64",
      ).toString("hex"),
      lastHex: Buffer.from(
        batch.positions[1]?.transport === "pulsar" ? batch.positions[1].serializedMessageId : "",
        "base64",
      ).toString("hex"),
    });
  });
  it("splits contiguous UTC publish hours without using payload event dates", async () => {
    const archive = fixture();
    await archiveMetricStreamDeliveries(
      archive.client,
      "archive",
      context(undefined, [Date.UTC(2026, 10, 5, 23), Date.UTC(2026, 10, 6, 0)]),
      archive.signal,
    );
    expect(archive.send).toHaveBeenCalledTimes(2);
    expect(
      archive.send.mock.calls.map(
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
    const archive = fixture();
    await expect(
      archiveMetricStreamDeliveries(archive.client, "archive", context([data]), archive.signal),
    ).rejects.toThrow(/UTF|line|900000|payload/i);
    expect(archive.send).not.toHaveBeenCalled();
  });
  it("accepts only identical complete gzip bytes after a create-only collision", async () => {
    const archive = fixture();
    await archiveMetricStreamDeliveries(archive.client, "archive", context(), archive.signal);
    const original = archive.send.mock.calls[0]?.[0];
    if (!(original instanceof PutObjectCommand) || !Buffer.isBuffer(original.input.Body))
      throw new Error("Invalid gzip fixture");
    archive.send
      .mockReset()
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 412 } })
      .mockImplementationOnce(async () => ({ Body: Readable.from([original.input.Body]) }));
    await expect(
      archiveMetricStreamDeliveries(archive.client, "archive", context(), archive.signal),
    ).resolves.toBeUndefined();
    expect(archive.send.mock.calls[1]?.[0]).toBeInstanceOf(GetObjectCommand);
  });
  it.each([Buffer.from("different"), Buffer.alloc(10000), Buffer.alloc(0)])(
    "rejects nonidentical collision content without overwriting",
    async (body) => {
      const archive = fixture();
      archive.send
        .mockRejectedValueOnce({ $metadata: { httpStatusCode: 412 } })
        .mockImplementationOnce(async () => ({ Body: Readable.from([body]) }));
      await expect(
        archiveMetricStreamDeliveries(archive.client, "archive", context(), archive.signal),
      ).rejects.toThrow(/collision|content/i);
      expect(archive.send).toHaveBeenCalledTimes(2);
    },
  );
  it("stops before a later hour when the earlier upload fails", async () => {
    const archive = fixture();
    archive.send.mockRejectedValue(new Error("upload uncertain"));
    await expect(
      archiveMetricStreamDeliveries(
        archive.client,
        "archive",
        context(undefined, [Date.UTC(2026, 10, 5, 23), Date.UTC(2026, 10, 6, 0)]),
        archive.signal,
      ),
    ).rejects.toThrow("upload uncertain");
    expect(archive.send).toHaveBeenCalledTimes(1);
  });
  it("awaits uploads and fails visibly on uncertain upload errors", async () => {
    const archive = fixture();
    archive.send.mockRejectedValue(new Error("upload uncertain"));
    await expect(
      archiveMetricStreamDeliveries(archive.client, "archive", context(), archive.signal),
    ).rejects.toThrow("upload uncertain");
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
  function intake(archive: ReturnType<typeof fixture>) {
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
    runtime.storage.mockReturnValue(archive.client);
    return { consumer, native };
  }
  it("awaits durable upload before ACK and closes all owned resources after intake", async () => {
    const archive = fixture(),
      { consumer, native } = intake(archive);
    const trace: string[] = [];
    archive.send.mockImplementation(async () => {
      trace.push("put");
      expect(consumer.acknowledge).not.toHaveBeenCalled();
      return {};
    });
    consumer.acknowledge.mockImplementation(async () => {
      trace.push("ack");
      signals.emit("SIGTERM");
      return null;
    });
    const destroy = vi.spyOn(archive.client, "destroy");
    await startMetricStreamR2ArchiveFromEnv();
    expect(trace).toEqual(["put", "ack"]);
    expect(native.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        receiverQueueSize: 20,
        batchReceivePolicy: { maxNumMessages: 20, maxNumBytes: 8 * 1024 * 1024, timeoutMs: 100 },
      }),
    );
    expect(consumer.close).toHaveBeenCalledOnce();
    expect(native.close).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });
  it("does not ACK an uncertain upload and reports failure after cleanup", async () => {
    const archive = fixture(),
      { consumer, native } = intake(archive);
    archive.send.mockRejectedValue(new Error("uncertain put"));
    await expect(startMetricStreamR2ArchiveFromEnv()).rejects.toThrow("uncertain put");
    expect(consumer.acknowledge).not.toHaveBeenCalled();
    expect(native.close).toHaveBeenCalledOnce();
    expect(runtime.capture).toHaveBeenCalled();
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
  it("marks readiness unavailable before cleaning up an aborted intake", async () => {
    const archive = fixture(),
      { native } = intake(archive);
    native.close.mockImplementation(async () => {
      expect(runtime.server.mock.calls[0]?.[0].getStatus()).toBe("unavailable");
      return null;
    });
    await startMetricStreamR2ArchiveFromEnv();
  });
  it("closes acquired storage when native client construction fails", async () => {
    const archive = fixture();
    intake(archive);
    const destroy = vi.spyOn(archive.client, "destroy");
    runtime.native.mockImplementation(function failedArchiveNativeClient() {
      throw new Error("native initialization failed");
    });
    await expect(startMetricStreamR2ArchiveFromEnv()).rejects.toThrow(
      "native initialization failed",
    );
    expect(destroy).toHaveBeenCalledOnce();
    expect(server.listen).not.toHaveBeenCalled();
  });
  it("settles native, storage and readiness cleanup when native close fails", async () => {
    const archive = fixture(),
      { native } = intake(archive);
    native.close.mockRejectedValue(new Error("native close failed"));
    const destroy = vi.spyOn(archive.client, "destroy");
    await expect(startMetricStreamR2ArchiveFromEnv()).rejects.toThrow("cleanup");
    expect(destroy).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
    expect(runtime.capture).toHaveBeenCalled();
  });
});
