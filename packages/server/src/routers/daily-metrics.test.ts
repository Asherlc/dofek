import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: unknown; userId: string | null; timezone: string }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    cachedProtectedQueryLight: () => trpc.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("../lib/typed-sql.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/typed-sql.ts")>();
  return {
    ...original,
    executeWithSchema: vi.fn(
      async (
        db: { execute: (q: unknown) => Promise<unknown[]> },
        _schema: unknown,
        query: unknown,
      ) => db.execute(query),
    ),
  };
});

import { dailyMetricsRouter } from "./daily-metrics.ts";

const createCaller = createTestCallerFactory(dailyMetricsRouter);

function makeCaller(rows: Record<string, unknown>[] = []) {
  return createCaller({
    db: { execute: vi.fn().mockResolvedValue(rows) },
    userId: "user-1",
    timezone: "UTC",
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
      const result = await caller.list({ days: 30, endDate: "2024-01-16" });
      expect(result).toEqual(rows);
    });

    it("rejects invalid endDate parameter", async () => {
      const caller = makeCaller([]);
      await expect(caller.list({ days: 30, endDate: "not-a-date" })).rejects.toThrow();
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
    it("filters rows by cutoff date derived from endDate param", async () => {
      // today=2024-01-16, days=30 → cutoff = 2023-12-17
      const rows = [
        { date: "2023-12-16", hrv: 50, resting_hr: 55, mean_60d: 52, sd_60d: 5, mean_7d: 51 },
        { date: "2023-12-17", hrv: 55, resting_hr: 54, mean_60d: 53, sd_60d: 5, mean_7d: 52 },
        { date: "2024-01-16", hrv: 60, resting_hr: 55, mean_60d: 55, sd_60d: 5, mean_7d: 58 },
      ];
      const caller = makeCaller(rows);
      const result = await caller.hrvBaseline({ days: 30, endDate: "2024-01-16" });

      // 2023-12-16 is before cutoff (2023-12-17), should be excluded
      expect(result.some((r) => r.date === "2023-12-16")).toBe(false);
      // 2023-12-17 is at cutoff, should be included (>=)
      expect(result.some((r) => r.date === "2023-12-17")).toBe(true);
      // 2024-01-16 is after cutoff, should be included
      expect(result.some((r) => r.date === "2024-01-16")).toBe(true);
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
      const result = await caller.trends({ days: 30, endDate: "2024-01-16" });
      expect(result).toEqual(rows[0]);
    });

    it("coerces PostgreSQL string aggregates to numbers via Zod schema", async () => {
      // PostgreSQL AVG/STDDEV return numeric strings like "55.00".
      // The trendsRowSchema uses z.coerce.number() to convert them.
      // This test verifies the coercion by having executeWithSchema actually
      // apply the schema instead of bypassing it.
      const { executeWithSchema } = await import("../lib/typed-sql.ts");
      const mockExecuteWithSchema = vi.mocked(executeWithSchema);

      // Temporarily restore real schema parsing for this test
      mockExecuteWithSchema.mockImplementationOnce(async (_db, schema, query) => {
        const dbTyped: { execute: (q: unknown) => Promise<unknown[]> } = _db;
        const rawRows = await dbTyped.execute(query);
        return rawRows.map((row) => schema.parse(row));
      });

      const rows = [
        {
          avg_resting_hr: "55.00",
          avg_hrv: "60.00",
          avg_spo2: "98.00",
          avg_steps: "8000",
          avg_active_energy: "500.00",
          avg_skin_temp: "36.50",
          stddev_resting_hr: "3.20",
          stddev_hrv: "10.50",
          stddev_spo2: "0.50",
          stddev_skin_temp: "0.30",
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
      const result = await caller.trends({ days: 30, endDate: "2024-01-16" });
      expect(result?.avg_resting_hr).toBe(55);
      expect(typeof result?.avg_resting_hr).toBe("number");
      expect(result?.stddev_hrv).toBe(10.5);
      expect(typeof result?.stddev_hrv).toBe("number");
    });

    it("returns null when no data", async () => {
      const caller = makeCaller([]);
      const result = await caller.trends({ days: 30, endDate: "2024-01-16" });
      expect(result).toBeNull();
    });
  });
});
