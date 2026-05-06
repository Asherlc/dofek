import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createPostgresTestActivitySensorStore } from "./activity-sensor-store.test-helpers.ts";

describe("PostgresTestActivitySensorStore", () => {
  it("uses metric stream sensor values for heart-rate zones", async () => {
    const execute = vi.fn().mockResolvedValueOnce([{ scalar: 110 }, { scalar: 140 }]);
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

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      { zone: 1, seconds: 1 },
      { zone: 2, seconds: 0 },
      { zone: 3, seconds: 0 },
      { zone: 4, seconds: 1 },
      { zone: 5, seconds: 0 },
    ]);
  });

  it("translates polarization trend queries to Postgres test data", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        { max_hr: 190, week: "2026-04-20", z1_seconds: 1300, z2_seconds: 400, z3_seconds: 200 },
      ]);
    const store = createPostgresTestActivitySensorStore({ execute });
    const rowSchema = z.object({
      max_hr: z.coerce.number(),
      week: z.string(),
      z1_seconds: z.coerce.number(),
      z2_seconds: z.coerce.number(),
      z3_seconds: z.coerce.number(),
    });

    const result = await store.query(
      rowSchema,
      `FROM analytics.activity_summary asum
       INNER JOIN analytics.deduped_sensor ds
       SELECT countIf(ds.scalar < am.max_hr * {p1:Float64})`,
      {
        userId: "00000000-0000-0000-0000-000000000001",
        timezone: "UTC",
        days: 90,
        enduranceTypes: ["cycling"],
        p1: 0.8,
        p2: 0.9,
      },
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      { max_hr: 190, week: "2026-04-20", z1_seconds: 1300, z2_seconds: 400, z3_seconds: 200 },
    ]);
  });

  it("fails fast for unsupported ClickHouse query shapes", async () => {
    const store = createPostgresTestActivitySensorStore({ execute: vi.fn() });
    const rowSchema = z.object({ value: z.number() });

    await expect(store.query(rowSchema, "SELECT value FROM analytics.unhandled")).rejects.toThrow(
      "does not support this ClickHouse query shape",
    );
  });
});
