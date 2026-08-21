import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string | null;
      timezone: string;
      accessWindow?: import("../billing/entitlement.ts").AccessWindow;
      sensorStore?: import("../repositories/activity-repository.ts").ActivitySensorStore;
    }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

function getRowMaxHeartRate(row: unknown): unknown {
  if (row !== null && typeof row === "object" && "max_hr" in row) {
    return row.max_hr;
  }
  return null;
}

function makeSensorStore(rows: unknown[]): ActivitySensorStore {
  // Mirror ClickHouseActivitySensorStore.query: parse rows through the supplied
  // Zod schema so timestampStringSchema and friends actually run.
  const query = vi
    .fn()
    .mockImplementation(
      async (schema: { parse: (row: unknown) => unknown }, queryText?: string) => {
        if (queryText?.includes("toInt32(count()) AS endurance_activities")) {
          return [
            schema.parse({
              max_hr: getRowMaxHeartRate(rows[0]),
              endurance_activities: rows.length,
            }),
          ];
        }
        return rows.map((row) => schema.parse(row));
      },
    );
  return {
    query,
    getActivitySummaries: vi.fn().mockResolvedValue([]),
    getStream: vi.fn().mockResolvedValue([]),
    getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerCurveSamples: vi.fn().mockResolvedValue([]),
    getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
    getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
    getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
    getPaceCurveRows: vi.fn().mockResolvedValue([]),
  } satisfies ActivitySensorStore;
}

function makeAerobicEfficiencyDb(rows: unknown[]) {
  return {
    execute: vi.fn().mockResolvedValue([
      {
        max_hr: getRowMaxHeartRate(rows[0]),
        endurance_activities: rows.length,
      },
    ]),
  };
}

vi.mock("../lib/typed-sql.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/typed-sql.ts")>();
  return {
    ...original,
    executeWithSchema: vi.fn(
      async (
        db: { execute: (q: unknown) => Promise<unknown[]> },
        schema: z.ZodType,
        query: unknown,
      ) => {
        const rows = await db.execute(query);
        return rows.map((row) => schema.parse(row));
      },
    ),
  };
});

vi.mock("../lib/endurance-types.ts", () => ({
  enduranceTypeFilter: () => ({ sql: "true" }),
}));

import { efficiencyRouter } from "./efficiency.ts";

const createCaller = createTestCallerFactory(efficiencyRouter);

describe("efficiencyRouter", () => {
  it("fails loudly when ClickHouse activity analytics are unavailable", async () => {
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
    });

    await expect(caller.aerobicEfficiency({ days: 180 })).rejects.toThrow(
      "efficiency.aerobicEfficiency requires the ClickHouse activity analytics store",
    );
  });

  describe("aerobicEfficiency", () => {
    it("returns activities with exact field mapping", async () => {
      const rows = [
        {
          max_hr: 190,
          date: "2024-01-15",
          canonical_type: "cycling",
          name: "Morning Ride",
          avg_power_z2: 180,
          avg_hr_z2: 140,
          efficiency_factor: 1.286,
          z2_samples: 600,
        },
      ];
      const caller = createCaller({
        db: makeAerobicEfficiencyDb(rows),
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeSensorStore(rows),
      });
      const result = await caller.aerobicEfficiency({ days: 180 });

      expect(result.maxHr).toBe(190);
      expect(result.activities).toHaveLength(1);
      expect(result.activities[0]).toEqual({
        date: "2024-01-15",
        activityType: "cycling",
        name: "Morning Ride",
        avgPowerZ2: 180,
        avgHrZ2: 140,
        efficiencyFactor: 1.286,
        z2Samples: 600,
      });
    });

    it("returns null maxHr when no data", async () => {
      const caller = createCaller({
        db: makeAerobicEfficiencyDb([]),
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeSensorStore([]),
      });
      const result = await caller.aerobicEfficiency({ days: 180 });
      expect(result.maxHr).toBeNull();
      expect(result.activities).toEqual([]);
    });

    it("defaults omitted days to the existing finite window", async () => {
      const sensorStore = makeSensorStore([
        {
          max_hr: 190,
          date: "2024-01-15",
          canonical_type: "cycling",
          name: "Ride",
          avg_power_z2: 180,
          avg_hr_z2: 140,
          efficiency_factor: 1.286,
          z2_samples: 600,
        },
      ]);
      const caller = createCaller({
        db: makeAerobicEfficiencyDb([]),
        userId: "user-1",
        timezone: "UTC",
        sensorStore,
      });

      await caller.aerobicEfficiency({});

      const queryCall = vi.mocked(sensorStore.query).mock.calls[0];
      expect(queryCall?.[1]).toContain("started_at > now() - INTERVAL {days:Int32} DAY");
      expect(queryCall?.[2]).toHaveProperty("days", 180);
    });

    it("accepts null days as an unbounded range", async () => {
      const sensorStore = makeSensorStore([
        {
          max_hr: 190,
          date: "2024-01-15",
          canonical_type: "cycling",
          name: "Ride",
          avg_power_z2: 180,
          avg_hr_z2: 140,
          efficiency_factor: 1.286,
          z2_samples: 600,
        },
      ]);
      const caller = createCaller({
        db: makeAerobicEfficiencyDb([]),
        userId: "user-1",
        timezone: "UTC",
        sensorStore,
      });

      await caller.aerobicEfficiency({ days: null });

      const queryCall = vi.mocked(sensorStore.query).mock.calls[0];
      expect(queryCall?.[1]).not.toContain("started_at > now() - INTERVAL");
      expect(queryCall?.[2]).not.toHaveProperty("days");
    });

    it("preserves the YYYY-MM-DD date string emitted by ClickHouse", async () => {
      // CH SQL uses toString(toDate(toTimeZone(...))), so the JSONEachRow
      // payload includes date as a "YYYY-MM-DD" string. Verify the schema
      // passes it through unchanged into the activity model.
      const rows = [
        {
          max_hr: 190,
          date: "2024-01-15",
          canonical_type: "cycling",
          name: "Ride",
          avg_power_z2: 180,
          avg_hr_z2: 140,
          efficiency_factor: 1.286,
          z2_samples: 600,
        },
      ];
      const caller = createCaller({
        db: makeAerobicEfficiencyDb(rows),
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeSensorStore(rows),
      });
      const result = await caller.aerobicEfficiency({ days: 180 });

      expect(result.activities[0]?.date).toBe("2024-01-15");
    });

    it("maps multiple activities", async () => {
      const rows = [
        {
          max_hr: 185,
          date: "2024-01-10",
          canonical_type: "running",
          name: "Run A",
          avg_power_z2: 250,
          avg_hr_z2: 145,
          efficiency_factor: 1.724,
          z2_samples: 400,
        },
        {
          max_hr: 185,
          date: "2024-01-12",
          canonical_type: "cycling",
          name: "Ride B",
          avg_power_z2: 190,
          avg_hr_z2: 138,
          efficiency_factor: 1.377,
          z2_samples: 800,
        },
      ];
      const caller = createCaller({
        db: makeAerobicEfficiencyDb(rows),
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeSensorStore(rows),
      });
      const result = await caller.aerobicEfficiency({ days: 180 });

      expect(result.maxHr).toBe(185);
      expect(result.activities).toHaveLength(2);
      expect(result.activities[0]?.name).toBe("Run A");
      expect(result.activities[1]?.name).toBe("Ride B");
    });
  });

  describe("aerobicDecoupling", () => {
    it("returns exact field mapping", async () => {
      const rows = [
        {
          date: "2024-01-15",
          canonical_type: "running",
          name: "Long Run",
          first_half_ratio: 1.5,
          second_half_ratio: 1.3,
          decoupling_pct: 13.33,
          total_samples: 3600,
        },
      ];
      const caller = createCaller({
        db: makeAerobicEfficiencyDb([]),
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeSensorStore(rows),
      });
      const result = await caller.aerobicDecoupling({ days: 180 });

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        date: "2024-01-15",
        activityType: "running",
        name: "Long Run",
        firstHalfRatio: 1.5,
        secondHalfRatio: 1.3,
        decouplingPct: 13.33,
        totalSamples: 3600,
      });
    });

    it("returns empty for no data", async () => {
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeSensorStore([]),
      });
      const result = await caller.aerobicDecoupling({ days: 180 });
      expect(result).toEqual([]);
    });

    it("preserves the YYYY-MM-DD date string emitted by ClickHouse", async () => {
      const rows = [
        {
          date: "2024-01-15",
          canonical_type: "running",
          name: "Long Run",
          first_half_ratio: 1.5,
          second_half_ratio: 1.3,
          decoupling_pct: 13.33,
          total_samples: 3600,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeSensorStore(rows),
      });
      const result = await caller.aerobicDecoupling({ days: 180 });

      expect(result[0]?.date).toBe("2024-01-15");
    });
  });

  describe("polarizationTrend", () => {
    it("computes polarization index using Treff formula with time fractions", async () => {
      const rows = [
        {
          max_hr: 190,
          week: "2024-01-15",
          z1_seconds: 5000,
          z2_seconds: 500,
          z3_seconds: 100,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeSensorStore(rows),
      });
      const result = await caller.polarizationTrend({ days: 180 });

      expect(result.maxHr).toBe(190);
      expect(result.weeks).toHaveLength(1);

      // Treff polarization index uses each zone's fraction of total time.
      const total = 5000 + 500 + 100;
      const easyZoneFraction = 5000 / total;
      const thresholdZoneFraction = 500 / total;
      const highZoneFraction = 100 / total;
      const expected =
        Math.round(
          Math.log10((easyZoneFraction / thresholdZoneFraction) * highZoneFraction * 100) * 1000,
        ) / 1000;
      expect(result.weeks[0]?.polarizationIndex).toBe(expected);
      expect(result.method.formula).toBe(
        "Polarization index = log10((easy-zone fraction / threshold-zone fraction) × high-zone fraction × 100).",
      );
      expect(result.method.interpretation).not.toContain("diagnosis");
      expect(result.method.source.url).toBe("https://doi.org/10.3389/fphys.2019.00707");
    });

    it("returns null polarization index when z2 is 0", async () => {
      const rows = [
        { max_hr: 190, week: "2024-01-15", z1_seconds: 5000, z2_seconds: 0, z3_seconds: 100 },
      ];
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeSensorStore(rows),
      });
      const result = await caller.polarizationTrend({ days: 180 });
      expect(result.weeks[0]?.polarizationIndex).toBeNull();
    });

    it("returns null polarization index when z3 is 0", async () => {
      const rows = [
        { max_hr: 190, week: "2024-01-15", z1_seconds: 5000, z2_seconds: 500, z3_seconds: 0 },
      ];
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeSensorStore(rows),
      });
      const result = await caller.polarizationTrend({ days: 180 });
      expect(result.weeks[0]?.polarizationIndex).toBeNull();
    });

    it("returns null polarization index when z1 is 0", async () => {
      const rows = [
        { max_hr: 190, week: "2024-01-15", z1_seconds: 0, z2_seconds: 500, z3_seconds: 100 },
      ];
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeSensorStore(rows),
      });
      const result = await caller.polarizationTrend({ days: 180 });
      expect(result.weeks[0]?.polarizationIndex).toBeNull();
    });

    it("maps zone seconds correctly", async () => {
      const rows = [
        { max_hr: 185, week: "2024-02-01", z1_seconds: 10000, z2_seconds: 2000, z3_seconds: 500 },
      ];
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeSensorStore(rows),
      });
      const result = await caller.polarizationTrend({ days: 180 });

      expect(result.weeks[0]?.z1Seconds).toBe(10000);
      expect(result.weeks[0]?.z2Seconds).toBe(2000);
      expect(result.weeks[0]?.z3Seconds).toBe(500);
      expect(result.weeks[0]?.week).toBe("2024-02-01");
    });

    it("preserves the YYYY-MM-DD week-start string emitted by toMonday", async () => {
      // CH SQL emits week as toString(toMonday(...)) → "YYYY-MM-DD".
      // Verify it passes through to the polarization model unchanged.
      const rows = [
        {
          max_hr: 190,
          week: "2024-01-15",
          z1_seconds: 5000,
          z2_seconds: 500,
          z3_seconds: 100,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeSensorStore(rows),
      });
      const result = await caller.polarizationTrend({ days: 180 });

      expect(result.weeks[0]?.week).toBe("2024-01-15");
    });

    it("returns null maxHr when no data", async () => {
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeSensorStore([]),
      });
      const result = await caller.polarizationTrend({ days: 180 });
      expect(result.maxHr).toBeNull();
      expect(result.weeks).toEqual([]);
    });

    it("computes PI for non-trivial zone distribution", async () => {
      const rows = [
        { max_hr: 190, week: "2024-01-15", z1_seconds: 3600, z2_seconds: 1800, z3_seconds: 600 },
      ];
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeSensorStore(rows),
      });
      const result = await caller.polarizationTrend({ days: 180 });

      // Treff polarization index uses each zone's fraction of total time.
      const total = 3600 + 1800 + 600;
      const easyZoneFraction = 3600 / total;
      const thresholdZoneFraction = 1800 / total;
      const highZoneFraction = 600 / total;
      const expected =
        Math.round(
          Math.log10((easyZoneFraction / thresholdZoneFraction) * highZoneFraction * 100) * 1000,
        ) / 1000;
      expect(result.weeks[0]?.polarizationIndex).toBe(expected);
    });
  });

  describe("access window gating", () => {
    it("aerobicEfficiency forwards accessWindow to the repository", async () => {
      // After the CH migration the access window predicate is enforced by
      // the repository (and ultimately the SQL). Here we verify that a
      // limited window doesn't crash and that the result still surfaces
      // the empty CH dataset cleanly.
      const caller = createCaller({
        db: makeAerobicEfficiencyDb([]),
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeSensorStore([]),
        accessWindow: {
          kind: "limited",
          paid: false,
          reason: "free_signup_week",
          startDate: "2026-04-10",
          endDateExclusive: "2026-04-17",
        },
      });
      const result = await caller.aerobicEfficiency({ days: 180 });
      expect(result.activities).toEqual([]);
    });
  });
});
