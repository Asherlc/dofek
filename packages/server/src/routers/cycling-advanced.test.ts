import { describe, expect, it, vi } from "vitest";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string | null;
      timezone: string;
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

// Apply Zod schema to mock CH rows so the same coerce/transform logic that runs
// in production also runs in tests. Mirrors ClickHouseActivitySensorStore.query.
function makeSensorStore(
  rowSets: unknown[][],
  rawActivityCount = rowSets.length > 0 ? 1 : 0,
): ActivitySensorStore {
  let rowSetIndex = 0;
  const query = vi
    .fn()
    .mockImplementation(async (schema: { parse: (row: unknown) => unknown }, queryText = "") => {
      if (queryText.includes("raw_activity_count")) {
        return [schema.parse({ raw_activity_count: rawActivityCount })];
      }
      const rows = rowSets[rowSetIndex] ?? [];
      rowSetIndex += 1;
      return rows.map((row) => schema.parse(row));
    });
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
  };
}

import { cyclingAdvancedRouter } from "./cycling-advanced.ts";

const createCaller = createTestCallerFactory(cyclingAdvancedRouter);

function makeCaller(rowSets: unknown[][], rawActivityCount?: number) {
  const count = rawActivityCount ?? (rowSets.length > 0 ? 1 : 0);
  return createCaller({
    db: { execute: vi.fn().mockResolvedValue([{ activity_count: count }]) },
    userId: "user-1",
    timezone: "UTC",
    sensorStore: makeSensorStore(rowSets, count),
  });
}

// These router tests verify the router → repository → model wiring. Detailed
// SQL/computation assertions live in the repository's own unit tests.
describe("cyclingAdvancedRouter", () => {
  describe("rampRate", () => {
    it("returns no-data result when sensor store is empty", async () => {
      const caller = makeCaller([[]]);
      const result = await caller.rampRate({ days: 90 });
      expect(result.weeks).toEqual([]);
      expect(result.currentRampRate).toBe(0);
      expect(result.recommendation).toBe("No data");
    });
  });

  describe("trainingMonotony", () => {
    it("maps repo rows into the wire shape", async () => {
      const caller = makeCaller([
        [
          {
            week: "2024-01-15",
            monotony: 1.5,
            strain: 300,
            weekly_load: 200,
            daily_mean_load: 28.57,
            daily_load_standard_deviation: 19.05,
          },
        ],
      ]);
      const result = await caller.trainingMonotony({ days: 90 });
      expect(result).toEqual([
        {
          week: "2024-01-15",
          monotony: 1.5,
          strain: 300,
          weeklyLoad: 200,
          dailyMeanLoad: 28.57,
          dailyLoadStandardDeviation: 19.05,
          method: {
            formula:
              "Monotony = 7-day mean daily cycling load ÷ population standard deviation of daily cycling load. Strain = weekly cycling load × monotony.",
            calendar: "Monday–Sunday calendar weeks include zero-load days.",
            activityScope: "Cycling activities with computed endurance training load.",
            interpretation:
              "These are descriptive workload-variability summaries, not an overtraining diagnosis.",
            source: {
              title: "Foster (1998), Monitoring training in athletes",
              url: "https://pubmed.ncbi.nlm.nih.gov/9662690/",
            },
          },
        },
      ]);
    });

    it("returns empty array when no data", async () => {
      const caller = makeCaller([[]]);
      const result = await caller.trainingMonotony({ days: 90 });
      expect(result).toEqual([]);
    });
  });

  describe("activityVariability", () => {
    it("returns empty when FTP estimation has no data", async () => {
      // First sensor query → FTP rows (empty). Repository short-circuits and
      // doesn't issue the second query.
      const caller = makeCaller([[]]);
      const result = await caller.activityVariability({ days: 90 });
      expect(result).toEqual({ rows: [], totalCount: 0, emptyReason: "no_ftp_estimate" });
    });

    it("computes VI and IF from FTP plus per-activity rows", async () => {
      // First sensor query → FTP estimate. Second → variability rows.
      const caller = makeCaller([
        [{ ftp: 250 }],
        [
          {
            activity_id: "ride-1",
            date: "2024-01-15",
            name: "Ride",
            np: 230,
            avg_power: 200,
            total_count: 1,
          },
        ],
      ]);
      const result = await caller.activityVariability({ days: 90 });

      expect(result.rows).toHaveLength(1);
      expect(result.totalCount).toBe(1);
      expect(result.emptyReason).toBeNull();
      expect(result.rows[0]?.normalizedPower).toBe(230);
      expect(result.rows[0]?.activityName).toBe("Ride");
      // VI = NP / avgPower = 230/200 = 1.15.
      expect(result.rows[0]?.variabilityIndex).toBe(1.15);
      // IF = NP / FTP = 230/250 = 0.92.
      expect(result.rows[0]?.intensityFactor).toBe(0.92);
    });
  });

  describe("verticalAscentRate", () => {
    it("computes VAM (m/h) from elevation gain over elapsed seconds", async () => {
      const caller = makeCaller([
        [
          {
            date: "2024-01-15",
            name: "Mountain Ride",
            canonical_type: "cycling",
            modality: "mountain",
            elevation_gain: 500,
            elapsed_seconds: 3600,
          },
        ],
      ]);
      const result = await caller.verticalAscentRate({ days: 90 });
      expect(result).toHaveLength(1);
      // 500m in 3600s = 500m/h.
      expect(result[0]?.verticalAscentRate).toBe(500);
      expect(result[0]?.elevationGainMeters).toBe(500);
      expect(result[0]?.activityName).toBe("Mountain Ride");
      expect(result[0]?.activityType).toBe("cycling");
      expect(result[0]?.modality).toBe("mountain");
    });

    it("returns empty when no climbing data", async () => {
      const caller = makeCaller([[]]);
      const result = await caller.verticalAscentRate({ days: 90 });
      expect(result).toEqual([]);
    });
  });

  describe("pedalDynamics", () => {
    it("maps left/right balance and torque/smoothness fields", async () => {
      const caller = makeCaller([
        [
          {
            date: "2024-01-15",
            name: "Trainer Ride",
            avg_balance: 49.5,
            avg_torque_effectiveness: 85.3,
            avg_pedal_smoothness: 22.1,
          },
        ],
      ]);
      const result = await caller.pedalDynamics({ days: 90 });
      expect(result).toEqual([
        {
          date: "2024-01-15",
          activityName: "Trainer Ride",
          leftRightBalance: 49.5,
          avgTorqueEffectiveness: 85.3,
          avgPedalSmoothness: 22.1,
        },
      ]);
    });
  });
});
