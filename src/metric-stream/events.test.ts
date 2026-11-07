import { describe, expect, it } from "vitest";
import {
  createMetricStreamBatchCompletedEvent,
  createMetricStreamDeletedEvent,
  createMetricStreamEvent,
  type MetricStreamDeleteScopeInput,
  type MetricStreamRowInput,
  metricStreamKafkaEventSchema,
  metricStreamProcessingContextSchema,
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
  it("keeps interval identity stable across display renames and distinguishes stable source facts", () => {
    const row = {
      ...baseMetricStreamRow,
      externalId: "hk:steps",
      channel: "step_count",
      deviceId: "Watch",
      metadata: { interval_end: "2026-06-06T19:00:01.000Z", source_bundle: "watch" },
    };
    const first = createCurrentMetricStreamEvent(row);
    expect(
      createCurrentMetricStreamEvent({
        ...row,
        metadata: { ...row.metadata, interval_end: "2026-06-06T19:00:02.000Z" },
      }).id,
    ).not.toBe(first.id);
    const renamed = createCurrentMetricStreamEvent({ ...row, deviceId: "Localized Watch" });
    expect(renamed.id).toBe(first.id);
    expect(renamed.deviceId).toBe("Localized Watch");
    expect(createCurrentMetricStreamEvent({ ...row, sourceType: "file" }).id).not.toBe(first.id);
    expect(
      createCurrentMetricStreamEvent({
        ...row,
        metadata: { ...row.metadata, source_bundle: "phone" },
      }).id,
    ).not.toBe(first.id);
    expect(createCurrentMetricStreamEvent({ ...row, generation: 1 }).id).not.toBe(first.id);
    expect(createCurrentMetricStreamEvent({ ...row, scalar: 15 }).id).toBe(first.id);
  });
  it("derives a stable id from the metric stream natural key", () => {
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

  it("rejects caller-supplied identity at the publication boundary", () => {
    const row = {
      ...baseMetricStreamRow,
      externalId: "hk:heart-rate-1",
      id: "10000000-0000-4000-8000-000000000001",
    };

    expect(() => createCurrentMetricStreamEvent(row)).toThrow();
  });

  it.each([
    { userId: "00000000-0000-0000-0000-000000000002" },
    { providerId: "garmin" },
    { recordedAt: "2026-06-06T19:00:00.001Z" },
  ])("derives a new identity when immutable fields change: %j", (change) => {
    const row = { ...baseMetricStreamRow, externalId: "hk:heart-rate-1" };
    expect(createCurrentMetricStreamEvent({ ...row, ...change }).id).not.toBe(
      createCurrentMetricStreamEvent(row).id,
    );
  });

  it("retains identity across activity and measurement corrections", () => {
    const row = { ...baseMetricStreamRow, externalId: "hk:heart-rate-1", scalar: 80 };
    expect(
      createCurrentMetricStreamEvent({
        ...row,
        activityId: "10000000-0000-4000-8000-000000000001",
        scalar: 90,
      }).id,
    ).toBe(createCurrentMetricStreamEvent(row).id);
  });

  it.each([1, 2])("preserves historical wire identity and precision in v%i", (version) => {
    const id = "10000000-0000-4000-8000-000000000001";
    const recordedAt = "2026-06-06T19:00:00.123456Z";
    const event = metricStreamKafkaEventSchema.parse({
      ...baseMetricStreamRow,
      version,
      ...(version === 2 ? { operationRevision } : {}),
      id,
      recordedAt,
    });
    expect(event).toMatchObject({ id, recordedAt });
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

  it("requires externalId", () => {
    expect(() => createCurrentMetricStreamEvent(baseMetricStreamRow)).toThrow(
      "Metric stream rows must include externalId",
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
      metricStreamKafkaEventSchema.parse({
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
    const result = metricStreamKafkaEventSchema.safeParse({
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
  const ownerUserId = "10000000-0000-4000-8000-000000000001";

  it("creates a v2 operation-correlated marker with concrete account owner", () => {
    const marker = createMetricStreamBatchCompletedEvent(
      {
        operationId: "30000000-0000-4000-8000-000000000001",
        userId: ownerUserId,
        batchId: "heart-rate-1",
        datasetKeys: ["recovery", "training"],
      },
      2,
    );

    expect(marker).toEqual({
      version: 2,
      eventType: "metric_stream_batch_completed",
      operationId: "30000000-0000-4000-8000-000000000001",
      userId: ownerUserId,
      batchId: "heart-rate-1",
      datasetKeys: ["recovery", "training"],
      expectedEventCount: 2,
      partitionKey: "processing:30000000-0000-4000-8000-000000000001:heart-rate-1",
    });
  });

  it("still parses legacy ownerless v1 markers for history/eraser", () => {
    expect(
      metricStreamKafkaEventSchema.parse({
        version: 1,
        eventType: "metric_stream_batch_completed",
        operationId: "30000000-0000-4000-8000-000000000001",
        batchId: "heart-rate-1",
        datasetKeys: ["recovery"],
        expectedEventCount: 1,
        partitionKey: "processing:30000000-0000-4000-8000-000000000001:heart-rate-1",
      }),
    ).toMatchObject({ version: 1 });
  });

  it("rejects empty dataset manifests, missing owner, and zero-event markers", () => {
    expect(() =>
      createMetricStreamBatchCompletedEvent(
        {
          operationId: "30000000-0000-4000-8000-000000000001",
          userId: ownerUserId,
          batchId: "heart-rate-1",
          datasetKeys: [],
        },
        1,
      ),
    ).toThrow();

    expect(() =>
      createMetricStreamBatchCompletedEvent(
        // Missing required userId — force runtime schema rejection without a type assertion.
        metricStreamProcessingContextSchema.parse({
          operationId: "30000000-0000-4000-8000-000000000001",
          batchId: "heart-rate-1",
          datasetKeys: ["recovery"],
        }),
        1,
      ),
    ).toThrow();

    expect(() =>
      createMetricStreamBatchCompletedEvent(
        {
          operationId: "30000000-0000-4000-8000-000000000001",
          userId: ownerUserId,
          batchId: "heart-rate-1",
          datasetKeys: ["recovery"],
        },
        0,
      ),
    ).toThrow();
  });

  it("accepts nil and non-RFC GUID owners on v2 markers while keeping operationId UUID-shaped", () => {
    const nilOwner = "00000000-0000-0000-0000-000000000000";
    const nonRfcOwner = "00000000-0000-0000-0000-000000000001";
    expect(
      createMetricStreamBatchCompletedEvent(
        {
          operationId: "30000000-0000-4000-8000-000000000001",
          userId: nilOwner,
          batchId: "nil-owner",
          datasetKeys: ["recovery"],
        },
        1,
      ).userId,
    ).toBe(nilOwner);
    expect(
      createMetricStreamBatchCompletedEvent(
        {
          operationId: "30000000-0000-4000-8000-000000000001",
          userId: nonRfcOwner,
          batchId: "non-rfc-owner",
          datasetKeys: ["recovery"],
        },
        1,
      ).userId,
    ).toBe(nonRfcOwner);
    expect(() =>
      createMetricStreamBatchCompletedEvent(
        {
          operationId: "00000000-0000-0000-0000-000000000001",
          userId: ownerUserId,
          batchId: "bad-operation",
          datasetKeys: ["recovery"],
        },
        1,
      ),
    ).toThrow();
  });
});
