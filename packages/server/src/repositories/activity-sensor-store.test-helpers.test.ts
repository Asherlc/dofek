import { describe, expect, it, vi } from "vitest";
import { createPostgresTestActivitySensorStore } from "./activity-sensor-store.test-helpers.ts";

describe("PostgresTestActivitySensorStore", () => {
  it("falls back to metric stream when deduped sensor values are missing", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ scalar: 110 }, { scalar: 120 }]);
    const store = createPostgresTestActivitySensorStore({ execute });

    const result = await store.getHeartRateZoneSeconds(
      {
        activityId: "activity-id",
        userId: "user-id",
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: null,
        memberActivityIds: ["linked-activity-id"],
      },
      160,
      60,
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result).toEqual([
      { zone: 1, seconds: 1 },
      { zone: 2, seconds: 1 },
      { zone: 3, seconds: 0 },
      { zone: 4, seconds: 0 },
      { zone: 5, seconds: 0 },
    ]);
  });

  it("falls back to metric stream when primary zone values are all zero seconds", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ scalar: 40 }])
      .mockResolvedValueOnce([{ scalar: 110 }, { scalar: 140 }]);
    const store = createPostgresTestActivitySensorStore({ execute });

    const result = await store.getHeartRateZoneSeconds(
      {
        activityId: "activity-id",
        userId: "user-id",
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: null,
        memberActivityIds: ["linked-activity-id", "linked-activity-id"],
      },
      160,
      60,
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result).toEqual([
      { zone: 1, seconds: 1 },
      { zone: 2, seconds: 0 },
      { zone: 3, seconds: 0 },
      { zone: 4, seconds: 1 },
      { zone: 5, seconds: 0 },
    ]);
  });

  it("uses the current activity as fallback source when member activities are empty", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ scalar: 110 }])
      .mockResolvedValueOnce([{ scalar: 120 }]);
    const store = createPostgresTestActivitySensorStore({ execute });

    const result = await store.getHeartRateZoneSeconds(
      {
        activityId: "activity-id",
        userId: "user-id",
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: null,
        memberActivityIds: [],
      },
      170,
      70,
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result).toEqual([
      { zone: 1, seconds: 1 },
      { zone: 2, seconds: 0 },
      { zone: 3, seconds: 0 },
      { zone: 4, seconds: 0 },
      { zone: 5, seconds: 0 },
    ]);
  });
});
