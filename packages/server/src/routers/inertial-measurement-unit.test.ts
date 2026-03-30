import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC.context<{ db: unknown; userId: string | null }>().create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
  };
});

import { inertialMeasurementUnitRouter } from "./inertial-measurement-unit.ts";

const createCaller = createTestCallerFactory(inertialMeasurementUnitRouter);

function makeExecute(rows: Record<string, unknown>[] = []) {
  return vi.fn().mockResolvedValue(rows);
}

describe("inertialMeasurementUnitRouter", () => {
  describe("getDailyHeatmap", () => {
    it("returns hourly heatmap data for a date range", async () => {
      const execute = makeExecute([
        { date: "2026-03-25", hour: "10", sample_count: "180000", coverage_percent: "100.0" },
        { date: "2026-03-25", hour: "11", sample_count: "90000", coverage_percent: "50.0" },
      ]);
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      const result = await caller.getDailyHeatmap({ days: 30 });

      expect(result).toEqual([
        { date: "2026-03-25", hour: 10, sampleCount: 180000, coveragePercent: 100 },
        { date: "2026-03-25", hour: 11, sampleCount: 90000, coveragePercent: 50 },
      ]);
    });

    it("returns empty array when no data", async () => {
      const execute = makeExecute([]);
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      const result = await caller.getDailyHeatmap({ days: 30 });
      expect(result).toEqual([]);
    });
  });

  describe("getCoverageTimeline", () => {
    it("returns coverage buckets for a given date", async () => {
      const execute = makeExecute([
        { bucket: "2026-03-25 10:00:00+00", sample_count: "15000" },
        { bucket: "2026-03-25 10:05:00+00", sample_count: "14800" },
      ]);
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      const result = await caller.getCoverageTimeline({ date: "2026-03-25" });

      expect(result).toEqual([
        { bucket: "2026-03-25 10:00:00+00", sampleCount: 15000 },
        { bucket: "2026-03-25 10:05:00+00", sampleCount: 14800 },
      ]);
    });

    it("returns empty array when no data", async () => {
      const execute = makeExecute([]);
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      const result = await caller.getCoverageTimeline({ date: "2026-03-25" });
      expect(result).toEqual([]);
    });

    it("rejects invalid date format", async () => {
      const execute = makeExecute([]);
      const caller = createCaller({ db: { execute }, userId: "user-1" });

      await expect(caller.getCoverageTimeline({ date: "not-a-date" })).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
    });
  });
});
