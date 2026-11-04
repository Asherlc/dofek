import { describe, expect, it } from "vitest";
import {
  createMetricStreamBatchCompletedEvent,
  createMetricStreamDeletedEvent,
  createMetricStreamEvent,
  createMetricStreamProviderGenerationDeletedEvent,
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

describe("provider generation deletion command codec", () => {
  it("derives fixed UUIDv5 root and successor slots independently of immutable command contents", () => {
    const input = {
      deletionEventId: "20000000-0000-4000-8000-000000000002",
      userId: "30000000-0000-4000-8000-000000000003",
      providerId: "garmin",
      generation: 2,
      sourceIds: [],
      complete: false,
      previousCommandId: null,
    };
    const root = createMetricStreamProviderGenerationDeletedEvent(input);
    expect(root.commandId).toBe("9f4dca66-ed4b-5f1f-a287-fa15fed6709d");
    const page = createMetricStreamProviderGenerationDeletedEvent({
      ...input,
      previousCommandId: root.commandId,
      sourceIds: ["40000000-0000-4000-8000-000000000004"],
    });
    expect(page.commandId).toBe("6d392e41-69d3-5500-b6d8-544436a28595");
    expect(
      createMetricStreamProviderGenerationDeletedEvent({
        ...page,
        sourceIds: ["50000000-0000-4000-8000-000000000005"],
        generation: 3,
      }).commandId,
    ).toBe(page.commandId);
    const mixedCaseRoot = "abcdef00-0000-4000-8000-000000000001";
    expect(
      createMetricStreamProviderGenerationDeletedEvent({
        ...input,
        deletionEventId: mixedCaseRoot.toUpperCase(),
      }).commandId,
    ).toBe(
      createMetricStreamProviderGenerationDeletedEvent({ ...input, deletionEventId: mixedCaseRoot })
        .commandId,
    );
  });
  it("rejects hand-crafted arbitrary root and fork successor identities in the wire codec", () => {
    const root = fence();
    const page = {
      ...root,
      commandId: "70000000-0000-4000-8000-000000000007",
      previousCommandId: root.commandId,
      sourceIds: ["40000000-0000-4000-8000-000000000004"],
    };
    for (const command of [root, page])
      expect(
        metricStreamRedpandaEventSchema.safeParse({
          ...command,
          commandId: "60000000-0000-4000-8000-000000000006",
        }).success,
      ).toBe(false);
  });
  const fence = () =>
    createMetricStreamProviderGenerationDeletedEvent({
      deletionEventId: "20000000-0000-4000-8000-000000000002",
      userId: "30000000-0000-4000-8000-000000000003",
      providerId: "garmin",
      generation: 2,
      sourceIds: [],
      complete: false,
      previousCommandId: null,
    });
  it.each([
    { generation: 0 },
    { generation: Number.MAX_SAFE_INTEGER + 1 },
    { commandId: "invalid" },
    { providerId: "" },
    { partitionKey: "different-route" },
    { complete: true },
    { sourceIds: ["40000000-0000-4000-8000-000000000004"] },
    { commandId: "20000000-0000-4000-8000-000000000002" },
    {
      commandId: "10000000-0000-4000-8000-000000000001",
      previousCommandId: "10000000-0000-4000-8000-000000000001",
      complete: true,
    },
    { previousCommandId: "50000000-0000-4000-8000-000000000005" },
    {
      previousCommandId: "50000000-0000-4000-8000-000000000005",
      complete: true,
      sourceIds: ["40000000-0000-4000-8000-000000000004"],
    },
    {
      previousCommandId: "50000000-0000-4000-8000-000000000005",
      sourceIds: Array(2).fill("40000000-0000-4000-8000-000000000004"),
    },
    {
      previousCommandId: "50000000-0000-4000-8000-000000000005",
      sourceIds: Array.from(
        { length: 1001 },
        (_, index) => `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      ),
    },
  ])("rejects malformed structural command %j", (change) => {
    const root = fence();
    const commandId =
      typeof change.previousCommandId === "string"
        ? createMetricStreamProviderGenerationDeletedEvent({
            ...root,
            previousCommandId: change.previousCommandId,
            complete: true,
          }).commandId
        : root.commandId;
    expect(
      metricStreamRedpandaEventSchema.safeParse({ ...root, commandId, ...change }).success,
    ).toBe(false);
  });
  it("retains the stable fence-only command and its fixed provider routing key", () => {
    const command = {
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
    };
    expect(metricStreamRedpandaEventSchema.parse(command)).toEqual(command);
  });
});

describe("createMetricStreamEvent", () => {
  it("preserves fractional source and scope timestamps across timezone normalization", () => {
    expect(
      createCurrentMetricStreamEvent({
        ...baseMetricStreamRow,
        externalId: "precision",
        recordedAt: "2026-11-03T02:00:00.123456+02:00",
      }).recordedAt,
    ).toBe("2026-11-03T00:00:00.123456Z");
    expect(
      createCurrentMetricStreamDeletedEvent({
        userId: "00000000-0000-4000-8000-000000000001",
        recordedAtStart: "2026-11-03T02:00:00.123455+02:00",
        recordedAtEnd: "2026-11-03T02:00:00.123457+02:00",
      }).scope,
    ).toMatchObject({
      recordedAtStart: "2026-11-03T00:00:00.123455Z",
      recordedAtEnd: "2026-11-03T00:00:00.123457Z",
    });
  });

  it("preserves historical generated IDs while emitting precise canonical timestamps", () => {
    for (const recordedAt of [
      "2026-11-03T00:00:00.123Z",
      "2026-11-03T00:00:00.123000Z",
      "2026-11-03T00:00:00.123456Z",
      "2026-11-03T02:00:00.1234560+02:00",
      "2026-11-03T00:00:00.123457Z",
    ]) {
      expect(
        createCurrentMetricStreamEvent({
          ...baseMetricStreamRow,
          externalId: "precision-identity",
          recordedAt,
        }).id,
      ).toBe("c5980e88-f3ae-590d-b8e9-32f0ff3867f0");
    }
    expect(
      createCurrentMetricStreamEvent({
        ...baseMetricStreamRow,
        externalId: "precision-identity",
        recordedAt: "2026-11-03T00:00:00.124Z",
      }).id,
    ).toBe("c9c1ccc4-047e-56dc-986b-c962dc0dac8b");
    expect(
      createCurrentMetricStreamEvent({
        ...baseMetricStreamRow,
        id: "10000000-0000-4000-8000-000000000001",
        recordedAt: "2026-11-03T00:00:00.123456Z",
      }).id,
    ).toBe("10000000-0000-4000-8000-000000000001");
  });

  it.each([
    ["2026-11-03T00:00:00.123000Z", "2026-11-03T00:00:00.123Z"],
    ["2026-11-03T02:00:00.1234560+02:00", "2026-11-03T00:00:00.123456Z"],
    ["2026-11-03T02:00:00.000000+02:00", "2026-11-03T00:00:00.000Z"],
  ])("canonicalizes equivalent timestamp representations: %s", (input, expected) => {
    expect(
      createCurrentMetricStreamEvent({
        ...baseMetricStreamRow,
        externalId: "precision",
        recordedAt: input,
      }).recordedAt,
    ).toBe(expected);
    expect(
      createCurrentMetricStreamDeletedEvent({
        userId: "00000000-0000-4000-8000-000000000001",
        recordedAtStart: input,
      }).scope.recordedAtStart,
    ).toBe(expected);
  });
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
