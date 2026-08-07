import { describe, expect, it } from "vitest";
import {
  createMetricStreamBatchCompletedEvent,
  createMetricStreamDeletedEvent,
  createMetricStreamEvent,
  type MetricStreamDeleteScopeInput,
  type MetricStreamRowInput,
  metricStreamRedpandaEventSchema,
} from "./events.ts";

const operationRevision = "1000000000000000";

function createCurrentMetricStreamEvent(row: MetricStreamRowInput) {
  return createMetricStreamEvent(row, operationRevision);
}

function createCurrentMetricStreamDeletedEvent(scope: MetricStreamDeleteScopeInput) {
  return createMetricStreamDeletedEvent(scope, operationRevision);
}

const baseMetricStreamRow = {
  recordedAt: "2026-06-06T19:00:00.000Z",
  userId: "00000000-0000-0000-0000-000000000001",
  providerId: "apple_health",
  sourceType: "api",
  channel: "heart_rate",
};

describe("createMetricStreamEvent", () => {
  it("derives a stable id from the metric stream natural key when no id is supplied", () => {
    const firstEvent = createCurrentMetricStreamEvent({
      ...baseMetricStreamRow,
      externalId: "hk:heart-rate-1",
    });
    const secondEvent = createCurrentMetricStreamEvent({
      ...baseMetricStreamRow,
      recordedAt: "2026-06-06T12:00:00-07:00",
      externalId: "hk:heart-rate-1",
    });

    expect(firstEvent.id).toBe(secondEvent.id);
    expect(firstEvent.id).toBe("5f637125-4373-589f-a3bf-e3421d6ce6fc");
    expect(firstEvent.generation).toBe(0);
  });

  it("fences reimported provider data with a new generation", () => {
    const firstGeneration = createCurrentMetricStreamEvent({
      ...baseMetricStreamRow,
      externalId: "hk:heart-rate-1",
      generation: 1,
    });
    const nextGeneration = createCurrentMetricStreamEvent({
      ...baseMetricStreamRow,
      externalId: "hk:heart-rate-1",
      generation: 2,
    });

    expect(firstGeneration.generation).toBe(1);
    expect(nextGeneration.generation).toBe(2);
    expect(firstGeneration.id).not.toBe(nextGeneration.id);
  });

  it("preserves a caller-supplied id", () => {
    const event = createCurrentMetricStreamEvent({
      ...baseMetricStreamRow,
      id: "10000000-0000-4000-8000-000000000001",
    });

    expect(event.id).toBe("10000000-0000-4000-8000-000000000001");
  });

  it("rejects invalid recordedAt timestamps", () => {
    expect(() =>
      createCurrentMetricStreamEvent({
        ...baseMetricStreamRow,
        externalId: "hk:heart-rate-1",
        recordedAt: "not-a-date",
      }),
    ).toThrow("recordedAt must be a valid timestamp");
  });

  it("preserves optional metric stream fields when they are present", () => {
    const event = createCurrentMetricStreamEvent({
      ...baseMetricStreamRow,
      externalId: "hk:heart-rate-1",
      deviceId: "Apple Watch",
      activityId: "10000000-0000-4000-8000-000000000001",
      vector: [1, 2, 3],
      point: '{"type":"Point","coordinates":[-122.4,37.8]}',
      metadata: { source: "test" },
    });

    expect(event.externalId).toBe("hk:heart-rate-1");
    expect(event.deviceId).toBe("Apple Watch");
    expect(event.activityId).toBe("10000000-0000-4000-8000-000000000001");
    expect(event.vector).toEqual([1, 2, 3]);
    expect(event.point).toBe('{"type":"Point","coordinates":[-122.4,37.8]}');
    expect(event.metadata).toEqual({ source: "test" });
  });

  it("requires externalId when no explicit id is supplied", () => {
    expect(() => createCurrentMetricStreamEvent(baseMetricStreamRow)).toThrow(
      "Metric stream rows without id must include externalId",
    );
  });
});

describe("createMetricStreamDeletedEvent", () => {
  it("creates a scoped delete event with a stable partition key", () => {
    const event = createCurrentMetricStreamDeletedEvent({
      activityId: "20000000-0000-4000-8000-000000000001",
    });

    expect(event).toEqual({
      version: 3,
      eventType: "metric_stream_deleted",
      eventId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      operationRevision,
      scope: {
        activityId: "20000000-0000-4000-8000-000000000001",
      },
      partitionKey: "activity:20000000-0000-4000-8000-000000000001",
    });
  });

  it("creates provider-scoped partition keys from every optional predicate", () => {
    const event = createCurrentMetricStreamDeletedEvent({
      userId: "10000000-0000-4000-8000-000000000001",
      providerId: "fitbit",
      externalId: null,
      channel: "body_weight",
      recordedAtStart: new Date("2026-03-01T00:00:00Z"),
      recordedAtEnd: "2026-03-02T00:00:00.000Z",
    });

    expect(event.scope).toEqual({
      userId: "10000000-0000-4000-8000-000000000001",
      providerId: "fitbit",
      externalId: null,
      channel: "body_weight",
      recordedAtStart: "2026-03-01T00:00:00.000Z",
      recordedAtEnd: "2026-03-02T00:00:00.000Z",
    });
    expect(event.partitionKey).toBe(
      "provider:10000000-0000-4000-8000-000000000001:fitbit:*:body_weight:2026-03-01T00:00:00.000Z:2026-03-02T00:00:00.000Z",
    );
  });

  it("creates an account-wide deletion scope from a user alone", () => {
    const event = createCurrentMetricStreamDeletedEvent({
      userId: "10000000-0000-4000-8000-000000000001",
    });

    expect(event.scope).toEqual({
      userId: "10000000-0000-4000-8000-000000000001",
    });
    expect(event.partitionKey).toBe("account:10000000-0000-4000-8000-000000000001");
  });

  it("rejects empty delete scopes", () => {
    expect(() => createCurrentMetricStreamDeletedEvent({})).toThrow(
      "Metric stream delete scope must include userId, activityId, or providerId",
    );
  });

  it("accepts version-one delete events during archive replay", () => {
    expect(
      metricStreamRedpandaEventSchema.parse({
        version: 1,
        eventType: "metric_stream_deleted",
        scope: { activityId: "20000000-0000-4000-8000-000000000001" },
        partitionKey: "activity:20000000-0000-4000-8000-000000000001",
      }),
    ).toEqual({
      version: 1,
      eventType: "metric_stream_deleted",
      scope: { activityId: "20000000-0000-4000-8000-000000000001" },
      partitionKey: "activity:20000000-0000-4000-8000-000000000001",
    });
  });

  it("rejects non-RFC UUIDs on version-two delete events", () => {
    const result = metricStreamRedpandaEventSchema.safeParse({
      version: 2,
      eventType: "metric_stream_deleted",
      eventId: "12345678-1234-1234-1234-123456789abc",
      scope: { activityId: "20000000-0000-4000-8000-000000000001" },
      partitionKey: "activity:20000000-0000-4000-8000-000000000001",
    });

    expect(result.success).toBe(false);
  });
});

describe("createMetricStreamBatchCompletedEvent", () => {
  it("creates an operation-correlated marker with a stable partition key", () => {
    const marker = createMetricStreamBatchCompletedEvent(
      {
        operationId: "30000000-0000-4000-8000-000000000001",
        batchId: "heart-rate-1",
        datasetKeys: ["recovery", "training"],
      },
      2,
    );

    expect(marker).toEqual({
      version: 1,
      eventType: "metric_stream_batch_completed",
      operationId: "30000000-0000-4000-8000-000000000001",
      batchId: "heart-rate-1",
      datasetKeys: ["recovery", "training"],
      expectedEventCount: 2,
      partitionKey: "processing:30000000-0000-4000-8000-000000000001:heart-rate-1",
    });
  });

  it("rejects empty dataset manifests and zero-event markers", () => {
    expect(() =>
      createMetricStreamBatchCompletedEvent(
        {
          operationId: "30000000-0000-4000-8000-000000000001",
          batchId: "heart-rate-1",
          datasetKeys: [],
        },
        1,
      ),
    ).toThrow();

    expect(() =>
      createMetricStreamBatchCompletedEvent(
        {
          operationId: "30000000-0000-4000-8000-000000000001",
          batchId: "heart-rate-1",
          datasetKeys: ["recovery"],
        },
        0,
      ),
    ).toThrow();
  });
});
