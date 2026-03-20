import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const t = initTRPC.context<{ db: unknown; userId: string | null }>().create();
  return {
    router: t.router,
    protectedProcedure: t.procedure,
    cachedProtectedQuery: () => t.procedure,
    cachedProtectedQueryLight: () => t.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("../lib/typed-sql.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/typed-sql.ts")>();
  return {
    ...original,
    executeWithSchema: vi.fn(
      async (db: { execute: () => Promise<unknown[]> }, schema: z.ZodType) => {
        const rows = await db.execute();
        return rows.map((row) => schema.parse(row));
      },
    ),
  };
});

import { dailyMetricsRouter } from "./daily-metrics.ts";

const createCaller = createTestCallerFactory(dailyMetricsRouter);

function makeCaller(rows: Record<string, unknown>[] = []) {
  return createCaller({
    db: { execute: vi.fn().mockResolvedValue(rows) },
    userId: "user-1",
  });
}

describe("dailyMetricsRouter", () => {
  describe("list", () => {
    it("returns daily metric rows", async () => {
      const rows = [
        { date: "2024-01-15", resting_hr: 55, hrv: 65 },
        { date: "2024-01-16", resting_hr: 56, hrv: 62 },
      ];
      const caller = makeCaller(rows);
      const result = await caller.list({ days: 30 });
      expect(result).toEqual(rows);
    });
  });

  describe("latest", () => {
    it("returns the latest daily metric", async () => {
      const rows = [{ date: "2024-01-16", resting_hr: 56, hrv: 62 }];
      const caller = makeCaller(rows);
      const result = await caller.latest();
      expect(result).toEqual(rows[0]);
    });

    it("returns null when no data", async () => {
      const caller = makeCaller([]);
      const result = await caller.latest();
      expect(result).toBeNull();
    });
  });

  describe("hrvBaseline", () => {
    it("filters rows by cutoff date", async () => {
      // Return rows that span before and after cutoff
      const rows = [
        { date: "2020-01-01", hrv: 50, resting_hr: 55, mean_60d: 52, sd_60d: 5, mean_7d: 51 },
        { date: "2099-12-31", hrv: 60, resting_hr: 55, mean_60d: 55, sd_60d: 5, mean_7d: 58 },
      ];
      const caller = makeCaller(rows);
      const result = await caller.hrvBaseline({ days: 30 });

      // The 2020 date is before cutoff, so should be filtered out
      // The 2099 date is after cutoff, so should be included
      expect(result.some((r) => r.date === "2099-12-31")).toBe(true);
      expect(result.some((r) => r.date === "2020-01-01")).toBe(false);
    });
  });

  describe("trends", () => {
    it("returns first row or null", async () => {
      const rows = [
        {
          avg_resting_hr: 55,
          avg_hrv: 60,
          avg_spo2: 98,
          avg_steps: 8000,
          avg_active_energy: 500,
          avg_skin_temp: 36.5,
          stddev_resting_hr: 3.2,
          stddev_hrv: 10.5,
          stddev_spo2: 0.5,
          stddev_skin_temp: 0.3,
          latest_resting_hr: 54,
          latest_hrv: 62,
          latest_spo2: 98,
          latest_steps: 9000,
          latest_active_energy: 550,
          latest_skin_temp: 36.6,
          latest_date: "2024-01-16",
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.trends({ days: 30 });
      expect(result).toEqual(rows[0]);
    });

    it("coerces string values from PostgreSQL aggregates to numbers", async () => {
      const rows = [
        {
          avg_resting_hr: "55.0",
          avg_hrv: "60.0",
          avg_spo2: "98.0",
          avg_steps: "8000.0",
          avg_active_energy: "500.0",
          avg_skin_temp: "36.5",
          stddev_resting_hr: "3.2",
          stddev_hrv: "10.5",
          stddev_spo2: "0.5",
          stddev_skin_temp: "0.3",
          latest_resting_hr: "54",
          latest_hrv: "62",
          latest_spo2: "98",
          latest_steps: "9000",
          latest_active_energy: "550",
          latest_skin_temp: "36.6",
          latest_date: "2024-01-16",
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.trends({ days: 30 });
      expect(result).toEqual({
        avg_resting_hr: 55,
        avg_hrv: 60,
        avg_spo2: 98,
        avg_steps: 8000,
        avg_active_energy: 500,
        avg_skin_temp: 36.5,
        stddev_resting_hr: 3.2,
        stddev_hrv: 10.5,
        stddev_spo2: 0.5,
        stddev_skin_temp: 0.3,
        latest_resting_hr: 54,
        latest_hrv: 62,
        latest_spo2: 98,
        latest_steps: 9000,
        latest_active_energy: 550,
        latest_skin_temp: 36.6,
        latest_date: "2024-01-16",
      });
    });

    it("returns null when no data", async () => {
      const caller = makeCaller([]);
      const result = await caller.trends({ days: 30 });
      expect(result).toBeNull();
    });
  });
});
