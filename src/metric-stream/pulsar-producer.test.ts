import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MetricStreamProcessingContext } from "./events.ts";
import {
  createPulsarMetricStreamEventPublisherForRoute,
  PulsarMetricStreamEventPublisher,
} from "./pulsar-producer.ts";

const sdk = vi.hoisted(() => ({ createProducer: vi.fn(), close: vi.fn(), construct: vi.fn() }));
const captureException = vi.hoisted(() => vi.fn());
vi.mock("pulsar-client", () => ({
  default: {
    Client: vi.fn(function FakePulsarClient(config) {
      sdk.construct(config);
      return { createProducer: sdk.createProducer, close: sdk.close };
    }),
  },
}));
vi.mock("../lib/error-reporting.ts", () => ({ captureException }));

const row = {
  recordedAt: "2026-06-06T12:00:00-07:00",
  userId: "00000000-0000-4000-8000-000000000001",
  providerId: "apple_health",
  externalId: "hk:heart-rate-1",
  sourceType: "api",
  channel: "heart_rate",
  scalar: 72,
};
const operationRevision = "9007199254740993";
const processing: MetricStreamProcessingContext = {
  operationId: "30000000-0000-4000-8000-000000000001",
  batchId: "batch-1",
  datasetKeys: ["recovery"],
};
type Message = { data: Buffer; partitionKey: string };
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  const send = vi.fn(async (_message: Message): Promise<unknown> => undefined);
  const close = vi.fn(async (): Promise<void> => undefined);
  const publisher = new PulsarMetricStreamEventPublisher({ send, close }, close);
  return { publisher, send, close };
}
const decode = (message: Message | undefined) => {
  if (!message) throw new Error("Expected a sent message");
  return JSON.parse(message.data.toString("utf8"));
};

describe("PulsarMetricStreamEventPublisher", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns stable versioned events after native acceptance using event IDs as keys", async () => {
    const { publisher, send } = setup();
    const events = await publisher.publishRows([row], { operationRevision });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      version: 2,
      operationRevision,
      recordedAt: "2026-06-06T19:00:00.000Z",
    });
    expect(send.mock.calls.map(([message]) => decode(message))).toEqual(events);
    expect(send.mock.calls[0]?.[0].partitionKey).toBe(events[0]?.id);
  });

  it("does not send rows or markers for empty input", async () => {
    const { publisher, send } = setup();
    await expect(publisher.publishRows([], { operationRevision, processing })).resolves.toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps explicit and processing keys and waits for row acceptance before the marker", async () => {
    const { publisher, send } = setup();
    const accepted = deferred();
    send.mockImplementationOnce(() => accepted.promise);
    const publishing = publisher.publishRows([row], {
      operationRevision,
      partitionKey: "replacement-key",
      processing,
    });
    expect(send).toHaveBeenCalledTimes(1);
    accepted.resolve();
    await publishing;
    expect(send.mock.calls.map(([message]) => message.partitionKey)).toEqual([
      "replacement-key",
      "replacement-key",
    ]);
    expect(decode(send.mock.calls[1]?.[0])).toMatchObject({
      eventType: "metric_stream_batch_completed",
      expectedEventCount: 1,
      batchId: "batch-1",
    });
  });

  it("admits at most twenty messages before waiting for the whole window", async () => {
    const { publisher, send } = setup();
    const held = Array.from({ length: 20 }, deferred);
    for (const item of held) send.mockImplementationOnce(() => item.promise);
    const publishing = publisher.publishRows(
      Array.from({ length: 21 }, (_, i) => ({ ...row, externalId: `row-${i}` })),
      { operationRevision },
    );
    expect(send).toHaveBeenCalledTimes(20);
    for (const item of held.slice(0, 19)) item.resolve();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(20);
    const last = held.at(-1);
    if (!last) throw new Error("Missing pending message");
    last.resolve();
    await publishing;
    expect(send).toHaveBeenCalledTimes(21);
  });

  it("bounds serialized bytes even when fewer than twenty messages fit", async () => {
    const { publisher, send } = setup();
    const accepted = deferred();
    send.mockImplementationOnce(() => accepted.promise);
    const publishing = publisher.publishRows(
      [0, 1].map((i) => ({
        ...row,
        externalId: `large-${i}`,
        metadata: { blob: "x".repeat(500_000) },
      })),
      { operationRevision },
    );
    expect(send).toHaveBeenCalledTimes(1);
    accepted.resolve();
    await publishing;
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.every(([message]) => message.data.byteLength <= 900_000)).toBe(true);
  });

  it("rejects an oversized atomic event without sending it", async () => {
    const { publisher, send } = setup();
    await expect(
      publisher.publishRows([{ ...row, metadata: { blob: "x".repeat(900_000) } }], {
        operationRevision,
      }),
    ).rejects.toThrow(/900000/);
    expect(send).not.toHaveBeenCalled();
  });

  it("waits for all pending outcomes after failure and never sends a later window or marker", async () => {
    const { publisher, send } = setup();
    const failed = deferred();
    const pending = deferred();
    send.mockImplementationOnce(() => failed.promise).mockImplementationOnce(() => pending.promise);
    const publishing = publisher.publishRows(
      Array.from({ length: 21 }, (_, i) => ({ ...row, externalId: `failure-${i}` })),
      { operationRevision, processing },
    );
    let settled = false;
    const outcome = publishing.then(
      () => "success",
      (error: Error) => {
        settled = true;
        return error;
      },
    );
    failed.reject(new Error("ProducerQueueIsFull"));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    pending.resolve();
    expect(await outcome).toMatchObject({
      message: expect.stringContaining("publication may have occurred"),
    });
    expect(send).toHaveBeenCalledTimes(20);
    expect(captureException).toHaveBeenCalledOnce();
  });

  it("accepts the delete before any replacement row and completes only after rows", async () => {
    const { publisher, send } = setup();
    const accepted = deferred();
    send.mockImplementationOnce(() => accepted.promise);
    const publishing = publisher.replaceRows(
      { activityId: "20000000-0000-4000-8000-000000000001" },
      [row],
      operationRevision,
      processing,
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(decode(send.mock.calls[0]?.[0]).eventType).toBe("metric_stream_deleted");
    accepted.resolve();
    const result = await publishing;
    expect(send.mock.calls.map(([message]) => decode(message))).toEqual([
      result.deleted,
      result.rows[0],
      expect.objectContaining({
        eventType: "metric_stream_batch_completed",
        expectedEventCount: 2,
      }),
    ]);
    expect(new Set(send.mock.calls.map(([message]) => message.partitionKey))).toEqual(
      new Set([result.deleted.partitionKey]),
    );
  });

  it("does not send replacements after delete rejection", async () => {
    const { publisher, send } = setup();
    send.mockRejectedValueOnce(new Error("Timeout"));
    await expect(
      publisher.replaceRows({ userId: row.userId }, [row], operationRevision, processing),
    ).rejects.toThrow("publication may have occurred");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(["size", "serialization"])(
    "rejects a replacement %s error before publishing its delete",
    async (failure) => {
      const { publisher, send } = setup();
      const original = JSON.stringify;
      const serialization = vi.spyOn(JSON, "stringify").mockImplementation((value) => {
        if (failure === "serialization" && value?.channel === "heart_rate")
          throw new TypeError("row serialization failed");
        return original(value);
      });
      try {
        const metadata: Record<string, string> =
          failure === "size" ? { blob: "x".repeat(900_000) } : { measurement: "direct" };
        await expect(
          publisher.replaceRows(
            { userId: row.userId },
            [{ ...row, metadata }],
            operationRevision,
            processing,
          ),
        ).rejects.toThrow();
        expect(send).not.toHaveBeenCalled();
      } finally {
        serialization.mockRestore();
      }
    },
  );

  it("rejects an oversized processing marker before publishing rows", async () => {
    const { publisher, send } = setup();
    await expect(
      publisher.publishRows([row], {
        operationRevision,
        processing: { ...processing, batchId: "x".repeat(900_000) },
      }),
    ).rejects.toThrow(/900000/);
    expect(send).not.toHaveBeenCalled();
  });

  it("validates later rows before submitting any otherwise-valid window", async () => {
    const { publisher, send } = setup();
    const rows = Array.from({ length: 21 }, (_, i) => ({ ...row, externalId: `preflight-${i}` }));
    await expect(
      publisher.publishRows([...rows, { ...row, metadata: { blob: "x".repeat(900_000) } }], {
        operationRevision,
      }),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["rows", "replacement"])(
    "validates the %s completion envelope before any publication",
    async (kind) => {
      const { publisher, send } = setup();
      const invalid = { ...processing, batchId: "" };
      const publishing =
        kind === "rows"
          ? publisher.publishRows([row], {
              operationRevision,
              partitionKey: "explicit",
              processing: invalid,
            })
          : publisher.replaceRows({ userId: row.userId }, [row], operationRevision, invalid);
      await expect(publishing).rejects.toThrow();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("closes resources once and rejects subsequent publication", async () => {
    const { publisher, send, close } = setup();
    await Promise.all([publisher.disconnect(), publisher.disconnect()]);
    expect(close).toHaveBeenCalledOnce();
    await expect(publisher.publishRows([row], { operationRevision })).rejects.toThrow(/closed/);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("Pulsar route factory", () => {
  const env = {
    PULSAR_SERVICE_URL: "pulsar://broker:6650",
    METRIC_STREAM_LIVE_TOPIC: "persistent://public/default/live",
    METRIC_STREAM_HISTORY_TOPIC: "persistent://public/default/history",
  };
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    sdk.close.mockResolvedValue(undefined);
  });
  it("requires the service URL before constructing native resources", async () => {
    await expect(
      createPulsarMetricStreamEventPublisherForRoute("live", {
        METRIC_STREAM_LIVE_TOPIC: env.METRIC_STREAM_LIVE_TOPIC,
      }),
    ).rejects.toThrow("PULSAR_SERVICE_URL");
    expect(sdk.construct).not.toHaveBeenCalled();
  });
  it("caches each resolved route and configures bounded native admission without blocking", async () => {
    const { createPulsarMetricStreamEventPublisherForRoute: create } = await import(
      "./pulsar-producer.ts"
    );
    const native = setup();
    sdk.createProducer.mockResolvedValue({ send: native.send, close: native.close });
    const first = await create("live", env);
    expect(await create("live", env)).toBe(first);
    expect(await create("history", env)).not.toBe(first);
    expect(sdk.createProducer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        topic: env.METRIC_STREAM_LIVE_TOPIC,
        maxPendingMessages: 20,
        maxPendingMessagesAcrossPartitions: 20,
        blockIfQueueFull: false,
        sendTimeoutMs: 30_000,
        batchingMaxMessages: 20,
        batchingMaxAllowedSizeInBytes: 900_000,
        chunkingEnabled: false,
      }),
    );
    expect(sdk.construct).toHaveBeenCalledTimes(2);
  });
  it("closes failed initialization resources, evicts the failure, and permits explicit reinitialization", async () => {
    const { createPulsarMetricStreamEventPublisherForRoute: create } = await import(
      "./pulsar-producer.ts"
    );
    sdk.createProducer.mockRejectedValueOnce(new Error("Unavailable"));
    await expect(create("live", env)).rejects.toThrow("Unavailable");
    expect(sdk.close).toHaveBeenCalledOnce();
    const native = setup();
    sdk.createProducer.mockResolvedValue({ send: native.send, close: native.close });
    await expect(create("live", env)).resolves.toHaveProperty("publishRows");
    expect(sdk.createProducer).toHaveBeenCalledTimes(2);
  });
  it("evicts closed publishers and closes the client even when producer close fails", async () => {
    const { createPulsarMetricStreamEventPublisherForRoute: create } = await import(
      "./pulsar-producer.ts"
    );
    const native = setup();
    native.close.mockRejectedValueOnce(new Error("close failed"));
    sdk.createProducer.mockResolvedValue({ send: native.send, close: native.close });
    const first = await create("live", env);
    await expect(first.disconnect()).rejects.toThrow("close failed");
    expect(sdk.close).toHaveBeenCalledOnce();
    expect(await create("live", env)).not.toBe(first);
  });

  it("preserves both shutdown failures and reports them without payload context", async () => {
    const { createPulsarMetricStreamEventPublisherForRoute: create } = await import(
      "./pulsar-producer.ts"
    );
    const native = setup();
    const producerError = new Error("producer close failed");
    const clientError = new Error("client close failed");
    native.close.mockRejectedValueOnce(producerError);
    sdk.close.mockRejectedValueOnce(clientError);
    sdk.createProducer.mockResolvedValue({ send: native.send, close: native.close });
    const publisher = await create("live", env);
    await expect(publisher.disconnect()).rejects.toMatchObject({
      errors: [producerError, clientError],
    });
    expect(captureException.mock.calls.map((call) => call[0])).toEqual([
      producerError,
      clientError,
    ]);
  });

  it("reports synchronous client construction failure and allows explicit reinitialization", async () => {
    const { createPulsarMetricStreamEventPublisherForRoute: create } = await import(
      "./pulsar-producer.ts"
    );
    sdk.construct.mockImplementationOnce(() => {
      throw new Error("invalid client config");
    });
    await expect(create("live", env)).rejects.toThrow("invalid client config");
    expect(captureException).toHaveBeenCalledOnce();
    const native = setup();
    sdk.createProducer.mockResolvedValue({ send: native.send, close: native.close });
    await expect(create("live", env)).resolves.toHaveProperty("publishRows");
    expect(sdk.close).not.toHaveBeenCalled();
  });

  it("waits for in-flight initialization, closes it once, and permanently rejects late factories", async () => {
    const {
      createPulsarMetricStreamEventPublisherForRoute: create,
      closeAllMetricStreamEventPublishers: closeAll,
    } = await import("./pulsar-producer.ts");
    const native = setup();
    const initialized = deferred();
    sdk.createProducer.mockImplementationOnce(() =>
      initialized.promise.then(() => ({ send: native.send, close: native.close })),
    );
    const starting = create("live", env);
    const stopping = closeAll();
    let complete = false;
    void stopping.then(() => {
      complete = true;
    });
    await expect(create("history", env)).rejects.toThrow(/shutting down/);
    expect(complete).toBe(false);
    initialized.resolve();
    await starting;
    await Promise.all([stopping, closeAll()]);
    expect(native.close).toHaveBeenCalledOnce();
    expect(sdk.close).toHaveBeenCalledOnce();
    await expect(create("live", env)).rejects.toThrow(/shutting down/);
  });

  it("settles every publisher close before reporting shutdown failure", async () => {
    const {
      createPulsarMetricStreamEventPublisherForRoute: create,
      closeAllMetricStreamEventPublishers: closeAll,
    } = await import("./pulsar-producer.ts");
    const first = setup();
    const second = setup();
    const held = deferred();
    first.close.mockRejectedValueOnce(new Error("first close failed"));
    second.close.mockImplementationOnce(() => held.promise);
    sdk.createProducer
      .mockResolvedValueOnce({ send: first.send, close: first.close })
      .mockResolvedValueOnce({ send: second.send, close: second.close });
    await create("live", env);
    await create("history", env);
    let complete = false;
    const outcome = closeAll().then(
      () => "success",
      (error: unknown) => {
        complete = true;
        return error;
      },
    );
    await vi.waitFor(() => expect(second.close).toHaveBeenCalledOnce());
    expect(complete).toBe(false);
    held.resolve();
    expect(await outcome).toBeInstanceOf(AggregateError);
    expect(sdk.close).toHaveBeenCalledTimes(2);
    expect(captureException).toHaveBeenCalledWith(
      expect.any(AggregateError),
      expect.objectContaining({
        tags: expect.objectContaining({ metricStreamFailure: "publisher-shutdown" }),
      }),
    );
  });

  it("cleans successful publishers even when another cached initialization fails", async () => {
    const {
      createPulsarMetricStreamEventPublisherForRoute: create,
      closeAllMetricStreamEventPublishers: closeAll,
    } = await import("./pulsar-producer.ts");
    const native = setup();
    const initialized = deferred();
    sdk.createProducer.mockResolvedValueOnce({ send: native.send, close: native.close });
    await create("live", env);
    sdk.createProducer.mockImplementationOnce(() => initialized.promise);
    const starting = create("history", env).catch((error: unknown) => error);
    const outcome = closeAll().catch((error: unknown) => error);
    initialized.reject(new Error("initialization failed"));
    expect(await starting).toMatchObject({ message: "initialization failed" });
    expect(await outcome).toBeInstanceOf(AggregateError);
    expect(native.close).toHaveBeenCalledOnce();
    expect(sdk.close).toHaveBeenCalledTimes(2);
  });
});
