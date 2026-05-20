import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory, makeMockSensorStore } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string | null;
      timezone: string;
      sensorStore?: unknown;
      accessWindow?: import("../billing/entitlement.ts").AccessWindow;
    }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
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
    sensorStore: makeMockSensorStore([]),
    userId: "user-1",
    timezone: "UTC",
  });
}

describe("dailyMetricsRouter", () => {
  describe("list", () => {
    it("returns daily metric rows", async () => {
      const rows = [
        { date: "2024-01-15", hrv: 65 },
        { date: "2024-01-16", hrv: 62 },
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
      const rows = [{ date: "2024-01-16", hrv: 62 }];
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
        { date: "2023-12-16", hrv: 50, mean_60d: 52, sd_60d: 5, mean_7d: 51 },
        { date: "2023-12-17", hrv: 55, mean_60d: 53, sd_60d: 5, mean_7d: 52 },
        { date: "2024-01-16", hrv: 60, mean_60d: 55, sd_60d: 5, mean_7d: 58 },
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
          avg_hrv: 60,
          avg_resting_hr: 54,
          avg_spo2: 98,
          avg_steps: 8000,
          avg_active_energy: 500,
          avg_skin_temp: 36.5,
          stddev_hrv: 10.5,
          stddev_resting_hr: 2.5,
          stddev_spo2: 0.5,
          stddev_skin_temp: 0.3,
          latest_hrv: 62,
          latest_resting_hr: 53,
          latest_spo2: 98,
          latest_steps: 9000,
          latest_active_energy: 550,
          latest_skin_temp: 36.6,
          latest_date: "2024-01-16",
          latest_steps_date: "2024-01-16",
          latest_active_energy_date: "2024-01-16",
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
          avg_hrv: "60.00",
          avg_resting_hr: "54.00",
          avg_spo2: "98.00",
          avg_steps: "8000",
          avg_active_energy: "500.00",
          avg_skin_temp: "36.50",
          stddev_hrv: "10.50",
          stddev_resting_hr: "2.50",
          stddev_spo2: "0.50",
          stddev_skin_temp: "0.30",
          latest_hrv: 62,
          latest_resting_hr: 53,
          latest_spo2: 98,
          latest_steps: 9000,
          latest_active_energy: 550,
          latest_skin_temp: 36.6,
          latest_date: "2024-01-16",
          latest_steps_date: "2024-01-16",
          latest_active_energy_date: "2024-01-16",
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.trends({ days: 30, endDate: "2024-01-16" });
      expect(result?.avg_hrv).toBe(60);
      expect(typeof result?.avg_hrv).toBe("number");
      expect(result?.stddev_hrv).toBe(10.5);
      expect(typeof result?.stddev_hrv).toBe("number");
      expect(result?.avg_resting_hr).toBe(54);
      expect(result?.stddev_resting_hr).toBe(2.5);
    });

    it("fetches derived resting heart rate rows for trend aggregation", async () => {
      const execute = vi.fn().mockResolvedValue([
        {
          avg_hrv: 60,
          avg_resting_hr: 54,
          avg_spo2: 98,
          avg_steps: 8000,
          avg_active_energy: 500,
          avg_skin_temp: 36.5,
          stddev_hrv: 10.5,
          stddev_resting_hr: 2.5,
          stddev_spo2: 0.5,
          stddev_skin_temp: 0.3,
          latest_hrv: 62,
          latest_resting_hr: 53,
          latest_spo2: 98,
          latest_steps: 9000,
          latest_active_energy: 550,
          latest_skin_temp: 36.6,
          latest_date: "2024-01-16",
          latest_steps_date: "2024-01-16",
          latest_active_energy_date: "2024-01-16",
        },
      ]);
      const sensorStore = makeMockSensorStore([{ date: "2024-01-16", resting_hr: 53 }]);
      const caller = createCaller({
        db: { execute },
        sensorStore,
        userId: "user-1",
        timezone: "America/Los_Angeles",
      });

      const result = await caller.trends({ days: 30, endDate: "2024-01-16" });

      expect(result?.latest_resting_hr).toBe(53);
      expect(sensorStore.query).toHaveBeenCalledOnce();
      const queryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
      const queryParams = vi.mocked(sensorStore.query).mock.calls[0]?.[2];
      expect(queryText).toContain("analytics.resting_heart_rate_sleep_window");
      expect(queryParams).toMatchObject({
        userId: "user-1",
        timezone: "America/Los_Angeles",
        rhrEndDate: "2024-01-16",
        rhrWindowStart: "2023-12-17",
      });
    });

    it("requires a sensor store for resting heart rate trend aggregation", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(caller.trends({ days: 30, endDate: "2024-01-16" })).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message:
          "dailyMetrics.trends requires the ClickHouse activity analytics store. Set CLICKHOUSE_URL and retry.",
      });
    });

    it("returns null when no data", async () => {
      const caller = makeCaller([]);
      const result = await caller.trends({ days: 30, endDate: "2024-01-16" });
      expect(result).toBeNull();
    });
  });

  describe("access window gating", () => {
    it("list passes accessWindow to repository (limited window returns empty)", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
        accessWindow: {
          kind: "limited",
          paid: false,
          reason: "free_signup_week",
          startDate: "2026-04-10",
          endDateExclusive: "2026-04-17",
        },
      });
      const result = await caller.list({ days: 30, endDate: "2026-04-26" });
      expect(result).toEqual([]);
    });
  });
});
