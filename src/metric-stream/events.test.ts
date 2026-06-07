import { describe, expect, it } from "vitest";
import { createMetricStreamDeletedEvent, createMetricStreamEvent } from "./events.ts";

const baseMetricStreamRow = {
  recordedAt: "2026-06-06T19:00:00.000Z",
  userId: "00000000-0000-0000-0000-000000000001",
  providerId: "apple_health",
  sourceType: "api",
  channel: "heart_rate",
};

describe("createMetricStreamEvent", () => {
  it("derives a stable id from the metric stream natural key when no id is supplied", () => {
    const firstEvent = createMetricStreamEvent({
      ...baseMetricStreamRow,
      externalId: "hk:heart-rate-1",
    });
    const secondEvent = createMetricStreamEvent({
      ...baseMetricStreamRow,
      recordedAt: "2026-06-06T12:00:00-07:00",
      externalId: "hk:heart-rate-1",
    });

    expect(firstEvent.id).toBe(secondEvent.id);
  });

  it("preserves a caller-supplied id", () => {
    const event = createMetricStreamEvent({
      ...baseMetricStreamRow,
      id: "10000000-0000-4000-8000-000000000001",
    });

    expect(event.id).toBe("10000000-0000-4000-8000-000000000001");
  });

  it("rejects invalid recordedAt timestamps", () => {
    expect(() =>
      createMetricStreamEvent({
        ...baseMetricStreamRow,
        externalId: "hk:heart-rate-1",
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
    expect(() => createMetricStreamEvent(baseMetricStreamRow)).toThrow(
      "Metric stream rows without id must include externalId",
    );
  });
});

describe("createMetricStreamDeletedEvent", () => {
  it("creates a scoped delete event with a stable partition key", () => {
    const event = createMetricStreamDeletedEvent({
      activityId: "20000000-0000-4000-8000-000000000001",
    });

    expect(event).toEqual({
      version: 1,
      eventType: "metric_stream_deleted",
      scope: {
        activityId: "20000000-0000-4000-8000-000000000001",
      },
      partitionKey: "activity:20000000-0000-4000-8000-000000000001",
    });
  });

  it("rejects empty delete scopes", () => {
    expect(() => createMetricStreamDeletedEvent({})).toThrow(
      "Metric stream delete scope must include activityId or providerId",
    );
  });
});
