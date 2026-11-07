import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMetricStreamDeletedEvent,
  createMetricStreamEvent,
} from "../metric-stream/events.ts";
import type { MetricStreamEventPublisher } from "../metric-stream/publisher.ts";
import {
  createLazyDefaultMetricStreamEventPublisher,
  createLazyMetricStreamEventPublisher,
  MetricStreamProcessingPublisher,
} from "./metric-stream-processing-publisher.ts";

const kafkaProducerMocks = vi.hoisted(() => ({
  getDefaultMetricStreamEventPublisher: vi.fn(),
}));

vi.mock("../metric-stream/publisher-factory.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../metric-stream/publisher-factory.ts")>()),
  getDefaultMetricStreamEventPublisher: kafkaProducerMocks.getDefaultMetricStreamEventPublisher,
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
  const publishRows = vi.fn<MetricStreamEventPublisher["publishRows"]>(async (rows, options) =>
    rows.map((row) => createMetricStreamEvent(row, options.operationRevision)),
  );
  const replaceRows = vi.fn<NonNullable<MetricStreamEventPublisher["replaceRows"]>>(
    async (scope, rows, revision) => ({
      deleted: createMetricStreamDeletedEvent(scope, revision),
      rows: rows.map((row) => createMetricStreamEvent(row, revision)),
    }),
  );
  const delegate: MetricStreamEventPublisher = { publishRows, replaceRows };
  const recordPublishedBatch = vi.fn(async () => undefined);
  const publisher = new MetricStreamProcessingPublisher(delegate, {
    operationId: "30000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000001",
    datasetKeys: ["recovery", "training"],
    recordPublishedBatch,
  });
  return { publisher, recordPublishedBatch, publishRows, replaceRows };
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
          userId: "00000000-0000-4000-8000-000000000001",
          datasetKeys: [],
          recordPublishedBatch: vi.fn(async () => undefined),
        }),
    ).toThrow("Metric-stream processing publisher requires at least one dataset");
  });

  it("uses a deterministic batch id and records broker-acknowledged publication evidence", async () => {
    const { publisher, recordPublishedBatch, publishRows } = makePublisher();

    expect(publisher.hasPublishedBatches).toBe(false);
    await publisher.publishRows([metricStreamRow], { operationRevision });
    await publisher.publishRows([metricStreamRow], { operationRevision });
    await publisher.publishRows([{ ...metricStreamRow, externalId: "hk:heart-rate-2" }], {
      operationRevision,
    });
    expect(publisher.hasPublishedBatches).toBe(true);

    const sentMarkers = publishRows.mock.calls.map(([_rows, options]) => options.processing);
    expect(sentMarkers[0]?.batchId).toBe(sentMarkers[1]?.batchId);
    expect(sentMarkers[2]?.batchId).not.toBe(sentMarkers[0]?.batchId);
    expect(recordPublishedBatch).toHaveBeenCalledTimes(3);
    expect(sentMarkers[0]).toMatchObject({
      userId: "00000000-0000-4000-8000-000000000001",
    });
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
        userId: "00000000-0000-4000-8000-000000000001",
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
        userId: "00000000-0000-4000-8000-000000000001",
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
          userId: "00000000-0000-4000-8000-000000000001",
          batchId: "existing-batch",
          datasetKeys: ["activity"],
        },
      }),
    ).rejects.toThrow("Metric-stream processing context is already assigned");
    expect(recordPublishedBatch).not.toHaveBeenCalled();
  });

  it("does not record a batch when no metric events were emitted", async () => {
    const { publisher, recordPublishedBatch, publishRows } = makePublisher();

    await expect(publisher.publishRows([], { operationRevision })).resolves.toEqual([]);

    expect(publisher.hasPublishedBatches).toBe(false);
    expect(publishRows).toHaveBeenCalledWith([], { operationRevision });
    expect(recordPublishedBatch).not.toHaveBeenCalled();
  });

  it("rejects publish rows owned by a different user", async () => {
    const { publisher, recordPublishedBatch, publishRows } = makePublisher();

    await expect(
      publisher.publishRows(
        [{ ...metricStreamRow, userId: "00000000-0000-4000-8000-000000000099" }],
        { operationRevision },
      ),
    ).rejects.toThrow(/must belong to the processing operation owner/);
    expect(recordPublishedBatch).not.toHaveBeenCalled();
    expect(publishRows).not.toHaveBeenCalled();
  });

  it("accepts publish rows when owner user id differs only by case", async () => {
    const { publisher, publishRows } = makePublisher();

    await publisher.publishRows(
      [{ ...metricStreamRow, userId: "00000000-0000-4000-8000-000000000001".toUpperCase() }],
      { operationRevision },
    );

    expect(publishRows).toHaveBeenCalledOnce();
  });

  it("rejects replace scope owned by a different user", async () => {
    const { publisher, replaceRows } = makePublisher();

    await expect(
      publisher.replaceRows(
        { userId: "00000000-0000-4000-8000-000000000099" },
        [metricStreamRow],
        operationRevision,
      ),
    ).rejects.toThrow(/replace scope must belong to the processing operation owner/);
    expect(replaceRows).not.toHaveBeenCalled();
  });

  it("correlates scoped delete-and-replace batches with the same operation", async () => {
    const { publisher, recordPublishedBatch, replaceRows } = makePublisher();

    await publisher.replaceRows(
      { activityId: "20000000-0000-4000-8000-000000000001" },
      [metricStreamRow],
      operationRevision,
    );

    const marker = replaceRows.mock.calls[0]?.[3];
    expect(marker).toMatchObject({
      operationId: "30000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000001",
      datasetKeys: ["recovery", "training"],
    });
    expect(recordPublishedBatch).toHaveBeenCalledWith({
      operationId: "30000000-0000-4000-8000-000000000001",
      batchId: marker?.batchId,
      datasetKeys: ["recovery", "training"],
      expectedEventCount: 2,
    });
  });

  it("rejects scoped replacement when the delegate does not support it", async () => {
    const publisher = new MetricStreamProcessingPublisher(
      { publishRows: vi.fn(async () => []) },
      {
        operationId: "30000000-0000-4000-8000-000000000001",
        userId: "00000000-0000-4000-8000-000000000001",
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
    kafkaProducerMocks.getDefaultMetricStreamEventPublisher.mockResolvedValue({
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
    expect(kafkaProducerMocks.getDefaultMetricStreamEventPublisher).toHaveBeenCalledTimes(1);
    expect(publishRows).toHaveBeenCalledWith([], { operationRevision });
    expect(replaceRows).toHaveBeenCalledWith(scope, [], operationRevision, undefined);
  });

  it("rejects replacement when the default delegate does not support it", async () => {
    kafkaProducerMocks.getDefaultMetricStreamEventPublisher.mockResolvedValue({
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

describe("createLazyMetricStreamEventPublisher", () => {
  it("defers route-specific publisher creation and reuses its delegate", async () => {
    const publishRows = vi.fn(async () => []);
    const createRoutePublisher = vi.fn(async () => ({ publishRows }));
    const publisher = createLazyMetricStreamEventPublisher(createRoutePublisher);

    expect(createRoutePublisher).not.toHaveBeenCalled();

    await publisher.publishRows([], { operationRevision });
    await publisher.publishRows([], { operationRevision });

    expect(createRoutePublisher).toHaveBeenCalledTimes(1);
    expect(publishRows).toHaveBeenCalledTimes(2);
  });
});
