import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  KafkaMetricStreamEventPublisher,
  type KafkaProducerLike,
  type KafkaProducerSendInput,
} from "../metric-stream/redpanda-producer.ts";
import {
  createLazyDefaultMetricStreamEventPublisher,
  MetricStreamProcessingPublisher,
} from "./metric-stream-processing-publisher.ts";

const redpandaProducerMocks = vi.hoisted(() => ({
  getDefaultMetricStreamEventPublisher: vi.fn(),
}));

vi.mock("../metric-stream/redpanda-producer.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../metric-stream/redpanda-producer.ts")>()),
  getDefaultMetricStreamEventPublisher: redpandaProducerMocks.getDefaultMetricStreamEventPublisher,
}));

const operationRevision = "1000000000000000";
const metricStreamRow = {
  recordedAt: "2026-06-06T12:00:00-07:00",
  userId: "00000000-0000-4000-8000-000000000001",
  providerId: "apple_health",
  externalId: "hk:heart-rate-1",
  sourceType: "api",
  channel: "heart_rate",
  scalar: 72,
};

function makePublisher() {
  const send = vi.fn(async (_input: KafkaProducerSendInput) => undefined);
  const producer: KafkaProducerLike = {
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    send,
  };
  const delegate = new KafkaMetricStreamEventPublisher(producer, "metric-stream-v1");
  const recordPublishedBatch = vi.fn(async () => undefined);
  const publisher = new MetricStreamProcessingPublisher(delegate, {
    operationId: "30000000-0000-4000-8000-000000000001",
    datasetKeys: ["recovery", "training"],
    recordPublishedBatch,
  });
  return { publisher, recordPublishedBatch, send };
}

describe("MetricStreamProcessingPublisher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires at least one dataset", () => {
    const delegate = { publishRows: vi.fn(async () => []) };

    expect(
      () =>
        new MetricStreamProcessingPublisher(delegate, {
          operationId: "30000000-0000-4000-8000-000000000001",
          datasetKeys: [],
          recordPublishedBatch: vi.fn(async () => undefined),
        }),
    ).toThrow("Metric-stream processing publisher requires at least one dataset");
  });

  it("uses a deterministic batch id and records broker-acknowledged publication evidence", async () => {
    const { publisher, recordPublishedBatch, send } = makePublisher();

    expect(publisher.hasPublishedBatches).toBe(false);
    await publisher.publishRows([metricStreamRow], { operationRevision });
    await publisher.publishRows([metricStreamRow], { operationRevision });
    await publisher.publishRows([{ ...metricStreamRow, externalId: "hk:heart-rate-2" }], {
      operationRevision,
    });
    expect(publisher.hasPublishedBatches).toBe(true);

    const sentMarkers = send.mock.calls.map((call) =>
      JSON.parse(call[0].messages.at(-1)?.value ?? "{}"),
    );
    expect(sentMarkers[0]?.batchId).toBe(sentMarkers[1]?.batchId);
    expect(sentMarkers[2]?.batchId).not.toBe(sentMarkers[0]?.batchId);
    expect(recordPublishedBatch).toHaveBeenCalledTimes(3);
    expect(recordPublishedBatch).toHaveBeenNthCalledWith(1, {
      operationId: "30000000-0000-4000-8000-000000000001",
      batchId: sentMarkers[0]?.batchId,
      datasetKeys: ["recovery", "training"],
      expectedEventCount: 1,
    });
    expect(recordPublishedBatch).toHaveBeenNthCalledWith(2, {
      operationId: "30000000-0000-4000-8000-000000000001",
      batchId: sentMarkers[0]?.batchId,
      datasetKeys: ["recovery", "training"],
      expectedEventCount: 1,
    });
  });

  it("persists batch intent before publishing and does not publish when persistence fails", async () => {
    const callOrder: string[] = [];
    const publishRows = vi.fn(async () => {
      callOrder.push("publish");
      return [];
    });
    const recordPublishedBatch = vi.fn(async () => {
      callOrder.push("persist");
    });
    const publisher = new MetricStreamProcessingPublisher(
      { publishRows },
      {
        operationId: "30000000-0000-4000-8000-000000000001",
        datasetKeys: ["recovery"],
        recordPublishedBatch,
      },
    );

    await publisher.publishRows([metricStreamRow], { operationRevision });

    expect(callOrder).toEqual(["persist", "publish"]);

    recordPublishedBatch.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(
      publisher.publishRows([{ ...metricStreamRow, externalId: "hk:heart-rate-2" }], {
        operationRevision,
      }),
    ).rejects.toThrow("database unavailable");
    expect(publishRows).toHaveBeenCalledOnce();
  });

  it("reports persisted intents whose broker publish has not completed", async () => {
    const publisher = new MetricStreamProcessingPublisher(
      {
        publishRows: vi.fn(async () => {
          throw new Error("broker unavailable");
        }),
      },
      {
        operationId: "30000000-0000-4000-8000-000000000001",
        datasetKeys: ["recovery"],
        recordPublishedBatch: vi.fn(async () => undefined),
      },
    );

    expect(publisher.hasUnpublishedBatchIntents).toBe(false);
    await expect(publisher.publishRows([metricStreamRow], { operationRevision })).rejects.toThrow(
      "broker unavailable",
    );
    expect(publisher.hasUnpublishedBatchIntents).toBe(true);
  });

  it("rejects preassigned processing context", async () => {
    const { publisher, recordPublishedBatch } = makePublisher();

    await expect(
      publisher.publishRows([metricStreamRow], {
        operationRevision,
        processing: {
          operationId: "30000000-0000-4000-8000-000000000002",
          batchId: "existing-batch",
          datasetKeys: ["activity"],
        },
      }),
    ).rejects.toThrow("Metric-stream processing context is already assigned");
    expect(recordPublishedBatch).not.toHaveBeenCalled();
  });

  it("does not record a batch when no metric events were emitted", async () => {
    const { publisher, recordPublishedBatch, send } = makePublisher();

    await expect(publisher.publishRows([], { operationRevision })).resolves.toEqual([]);

    expect(publisher.hasPublishedBatches).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(recordPublishedBatch).not.toHaveBeenCalled();
  });

  it("correlates scoped delete-and-replace batches with the same operation", async () => {
    const { publisher, recordPublishedBatch, send } = makePublisher();

    await publisher.replaceRows(
      { activityId: "20000000-0000-4000-8000-000000000001" },
      [metricStreamRow],
      operationRevision,
    );

    const marker = JSON.parse(send.mock.calls[0]?.[0].messages.at(-1)?.value ?? "{}");
    expect(marker).toMatchObject({
      eventType: "metric_stream_batch_completed",
      operationId: "30000000-0000-4000-8000-000000000001",
      datasetKeys: ["recovery", "training"],
      expectedEventCount: 2,
    });
    expect(recordPublishedBatch).toHaveBeenCalledWith({
      operationId: "30000000-0000-4000-8000-000000000001",
      batchId: marker.batchId,
      datasetKeys: ["recovery", "training"],
      expectedEventCount: 2,
    });
  });

  it("rejects scoped replacement when the delegate does not support it", async () => {
    const publisher = new MetricStreamProcessingPublisher(
      { publishRows: vi.fn(async () => []) },
      {
        operationId: "30000000-0000-4000-8000-000000000001",
        datasetKeys: ["activity"],
        recordPublishedBatch: vi.fn(async () => undefined),
      },
    );

    await expect(
      publisher.replaceRows(
        { activityId: "20000000-0000-4000-8000-000000000001" },
        [],
        operationRevision,
      ),
    ).rejects.toThrow("Metric stream publisher does not support scoped replacement");
  });
});

describe("createLazyDefaultMetricStreamEventPublisher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lazily resolves one delegate and forwards publication methods", async () => {
    const publishRows = vi.fn(async () => []);
    const replaceRows = vi.fn(async () => ({ deleted: 0, rows: [] }));
    redpandaProducerMocks.getDefaultMetricStreamEventPublisher.mockResolvedValue({
      publishRows,
      replaceRows,
    });
    const publisher = createLazyDefaultMetricStreamEventPublisher();
    const scope = { activityId: "20000000-0000-4000-8000-000000000001" };

    await expect(publisher.publishRows([], { operationRevision })).resolves.toEqual([]);
    await expect(publisher.replaceRows?.(scope, [], operationRevision)).resolves.toEqual({
      deleted: 0,
      rows: [],
    });
    expect(redpandaProducerMocks.getDefaultMetricStreamEventPublisher).toHaveBeenCalledTimes(1);
    expect(publishRows).toHaveBeenCalledWith([], { operationRevision });
    expect(replaceRows).toHaveBeenCalledWith(scope, [], operationRevision, undefined);
  });

  it("rejects replacement when the default delegate does not support it", async () => {
    redpandaProducerMocks.getDefaultMetricStreamEventPublisher.mockResolvedValue({
      publishRows: vi.fn(async () => []),
    });
    const publisher = createLazyDefaultMetricStreamEventPublisher();

    await expect(
      publisher.replaceRows?.(
        { activityId: "20000000-0000-4000-8000-000000000001" },
        [],
        operationRevision,
      ),
    ).rejects.toThrow("Metric stream publisher does not support scoped replacement");
  });
});
