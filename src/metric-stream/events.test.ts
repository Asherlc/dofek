import { describe, expect, it } from "vitest";
import {
  createMetricStreamEvent,
  metricStreamEventV1Schema,
  metricStreamRowInputSchema,
} from "./events.ts";

const baseMetricStreamRow = {
  recordedAt: "2026-06-06T19:00:00.000Z",
  userId: "00000000-0000-0000-0000-000000000001",
  providerId: "apple_health",
  sourceType: "api",
  channel: "heart_rate",
};

const baseMetricStreamEvent = {
  version: 1,
  id: "10000000-0000-4000-8000-000000000001",
  recordedAt: "2026-06-06T19:00:00.000Z",
  userId: "00000000-0000-0000-0000-000000000001",
  providerId: "apple_health",
  externalId: null,
  deviceId: null,
  sourceType: "api",
  channel: "heart_rate",
  activityId: null,
  scalar: null,
  vector: null,
  point: null,
  metadata: null,
};

describe("createMetricStreamEvent", () => {
  it("rejects invalid recordedAt timestamps", () => {
    expect(() =>
      createMetricStreamEvent({
        ...baseMetricStreamRow,
        recordedAt: "not-a-date",
      }),
    ).toThrow("recordedAt must be a valid timestamp");
  });

  it("preserves optional metric stream fields when they are present", () => {
    const event = createMetricStreamEvent({
      ...baseMetricStreamRow,
      externalId: "hk:heart-rate-1",
      deviceId: "Apple Watch",
      activityId: "10000000-0000-4000-8000-000000000001",
      scalar: 72,
      vector: [1, 2, 3],
      point: '{"type":"Point","coordinates":[-122.4,37.8]}',
      metadata: { source: "test" },
    });

    expect(event.externalId).toBe("hk:heart-rate-1");
    expect(event.deviceId).toBe("Apple Watch");
    expect(event.activityId).toBe("10000000-0000-4000-8000-000000000001");
    expect(event.scalar).toBe(72);
    expect(event.vector).toEqual([1, 2, 3]);
    expect(event.point).toBe('{"type":"Point","coordinates":[-122.4,37.8]}');
    expect(event.metadata).toEqual({ source: "test" });
  });
});

describe("metricStreamRowInputSchema", () => {
  it("requires the metric stream row object shape", () => {
    expect(metricStreamRowInputSchema.safeParse({}).success).toBe(false);
    expect(metricStreamRowInputSchema.safeParse(baseMetricStreamRow).success).toBe(true);
  });

  it("requires non-empty source identifiers", () => {
    expect(
      metricStreamRowInputSchema.safeParse({
        ...baseMetricStreamRow,
        providerId: "",
      }).success,
    ).toBe(false);
    expect(
      metricStreamRowInputSchema.safeParse({
        ...baseMetricStreamRow,
        sourceType: "",
      }).success,
    ).toBe(false);
    expect(
      metricStreamRowInputSchema.safeParse({
        ...baseMetricStreamRow,
        channel: "",
      }).success,
    ).toBe(false);
    expect(
      metricStreamRowInputSchema.safeParse({
        ...baseMetricStreamRow,
        externalId: "",
      }).success,
    ).toBe(false);
  });

  it("accepts Date timestamps, non-empty vectors, and nested JSON metadata", () => {
    const result = metricStreamRowInputSchema.safeParse({
      ...baseMetricStreamRow,
      recordedAt: new Date("2026-06-06T19:00:00.000Z"),
      vector: [1, 2],
      metadata: {
        source: "test",
        flags: [true, false],
        nested: { count: 2, note: null },
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.recordedAt).toBe("2026-06-06T19:00:00.000Z");
    expect(result.data.vector).toEqual([1, 2]);
    expect(result.data.metadata).toEqual({
      source: "test",
      flags: [true, false],
      nested: { count: 2, note: null },
    });
  });

  it("rejects empty timestamp strings and empty vectors", () => {
    expect(
      metricStreamRowInputSchema.safeParse({
        ...baseMetricStreamRow,
        recordedAt: "",
      }).success,
    ).toBe(false);
    expect(
      metricStreamRowInputSchema.safeParse({
        ...baseMetricStreamRow,
        vector: [],
      }).success,
    ).toBe(false);
  });
});

describe("metricStreamEventV1Schema", () => {
  it("requires the emitted metric stream event object shape", () => {
    expect(metricStreamEventV1Schema.safeParse({}).success).toBe(false);
    expect(metricStreamEventV1Schema.safeParse(baseMetricStreamEvent).success).toBe(true);
  });

  it("requires recordedAt to include a timezone offset", () => {
    expect(
      metricStreamEventV1Schema.safeParse({
        ...baseMetricStreamEvent,
        recordedAt: "2026-06-06T19:00:00.000",
      }).success,
    ).toBe(false);
    expect(
      metricStreamEventV1Schema.safeParse({
        ...baseMetricStreamEvent,
        recordedAt: "2026-06-06T19:00:00.000-07:00",
      }).success,
    ).toBe(true);
  });

  it("accepts non-empty vectors and nested JSON metadata", () => {
    expect(
      metricStreamEventV1Schema.safeParse({
        ...baseMetricStreamEvent,
        vector: [1, 2],
        metadata: {
          source: "test",
          flags: [true, false],
          nested: { count: 2, note: null },
        },
      }).success,
    ).toBe(true);
  });

  it("rejects empty vectors and empty source identifiers", () => {
    expect(
      metricStreamEventV1Schema.safeParse({
        ...baseMetricStreamEvent,
        vector: [],
      }).success,
    ).toBe(false);
    expect(
      metricStreamEventV1Schema.safeParse({
        ...baseMetricStreamEvent,
        providerId: "",
      }).success,
    ).toBe(false);
    expect(
      metricStreamEventV1Schema.safeParse({
        ...baseMetricStreamEvent,
        channel: "",
      }).success,
    ).toBe(false);
  });
});
