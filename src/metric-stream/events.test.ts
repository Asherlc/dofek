import { describe, expect, it } from "vitest";
import { createMetricStreamEvent } from "./events.ts";

const baseMetricStreamRow = {
  recordedAt: "2026-06-06T19:00:00.000Z",
  userId: "00000000-0000-0000-0000-000000000001",
  providerId: "apple_health",
  sourceType: "api",
  channel: "heart_rate",
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
});
