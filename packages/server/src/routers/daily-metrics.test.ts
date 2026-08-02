import { describe, expect, it, vi } from "vitest";
import { collectSqlText, createTestCallerFactory, makeMockSensorStore } from "./test-helpers.ts";

type ProcessingStatusQuery = { datasets?: readonly ["recovery"] };

const processingStatusMock = vi.hoisted(() =>
  vi.fn(async (_input: ProcessingStatusQuery) => ({
    overallStatus: "ready" as const,
    datasets: [{ key: "recovery" as const, status: "ready" as const }],
  })),
);

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

vi.mock("../repositories/processing-repository.ts", () => ({
  ProcessingRepository: class {
    status(input: ProcessingStatusQuery) {
      return processingStatusMock(input);
    }
  },
}));

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

    it("uses a lower date bound for finite selected ranges", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute },
        sensorStore: makeMockSensorStore([]),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.list({ days: 30, endDate: "2024-01-16" });

      expect(collectSqlText(execute.mock.calls[0]?.[0])).toContain("AND date >");
    });

    it("omits the lower date bound when days is null", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute },
        sensorStore: makeMockSensorStore([]),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.list({ days: null, endDate: "2024-01-16" });

      const queryText = collectSqlText(execute.mock.calls[0]?.[0]);
      expect(queryText).toContain("WHERE user_id =");
      expect(queryText).toContain("AND date <=");
      expect(queryText).not.toContain("AND date >");
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
    it("fetches derived resting heart rate rows for the baseline chart", async () => {
      const rows = [
        {
          date: "2024-01-16",
          hrv: 60,
          resting_hr: 53,
          mean_60d: 55,
          sd_60d: 5,
          mean_7d: 58,
          resting_hr_mean_7d: 54,
        },
      ];
      const execute = vi.fn().mockResolvedValue(rows);
      const sensorStore = makeMockSensorStore([{ date: "2024-01-16", resting_hr: 53 }]);
      const caller = createCaller({
        db: { execute },
        sensorStore,
        userId: "user-1",
        timezone: "America/Los_Angeles",
      });

      const result = await caller.hrvBaseline({ days: 30, endDate: "2024-01-16" });

      expect(result[0]?.resting_hr).toBe(53);
      expect(result[0]?.resting_hr_mean_7d).toBe(54);
      expect(sensorStore.query).toHaveBeenCalledOnce();
      const queryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
      const queryParams = vi.mocked(sensorStore.query).mock.calls[0]?.[2];
      expect(queryText).toContain("analytics.resting_heart_rate_sleep_window");
      expect(queryParams).toMatchObject({
        userId: "user-1",
        timezone: "America/Los_Angeles",
        rhrEndDate: "2024-01-16",
        rhrWindowStart: "2023-10-18",
      });
    });

    it("filters rows by cutoff date derived from endDate param", async () => {
      // endDate=2024-01-16, days=30 → inclusive start = 2023-12-18
      const rows = [
        {
          date: "2023-12-17",
          hrv: 50,
          resting_hr: 57,
          mean_60d: 52,
          sd_60d: 5,
          mean_7d: 51,
          resting_hr_mean_7d: 56,
        },
        {
          date: "2023-12-18",
          hrv: 55,
          resting_hr: 56,
          mean_60d: 53,
          sd_60d: 5,
          mean_7d: 52,
          resting_hr_mean_7d: 55,
        },
        {
          date: "2024-01-16",
          hrv: 60,
          resting_hr: 53,
          mean_60d: 55,
          sd_60d: 5,
          mean_7d: 58,
          resting_hr_mean_7d: 54,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.hrvBaseline({ days: 30, endDate: "2024-01-16" });

      // 2023-12-17 is one day before the requested range
      expect(result.some((r) => r.date === "2023-12-17")).toBe(false);
      // 2023-12-18 is the inclusive start
      expect(result.some((r) => r.date === "2023-12-18")).toBe(true);
      // 2024-01-16 is the inclusive end
      expect(result.some((r) => r.date === "2024-01-16")).toBe(true);
    });

    it("fetches unbounded resting heart rate and skips baseline cutoff when days is null", async () => {
      const rows = [
        {
          date: "2023-01-01",
          hrv: 50,
          resting_hr: 57,
          mean_60d: 52,
          sd_60d: 5,
          mean_7d: 51,
          resting_hr_mean_7d: 56,
        },
      ];
      const execute = vi.fn().mockResolvedValue(rows);
      const sensorStore = makeMockSensorStore([{ date: "2023-01-01", resting_hr: 57 }]);
      const caller = createCaller({
        db: { execute },
        sensorStore,
        userId: "user-1",
        timezone: "America/Los_Angeles",
      });

      const result = await caller.hrvBaseline({ days: null, endDate: "2024-01-16" });

      expect(result).toEqual(rows);
      const queryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
      const queryParams = vi.mocked(sensorStore.query).mock.calls[0]?.[2];
      expect(queryText).not.toContain("rhrWindowStart");
      expect(queryParams).toMatchObject({
        userId: "user-1",
        timezone: "America/Los_Angeles",
        rhrEndDate: "2024-01-16",
      });
      expect(queryParams).not.toHaveProperty("rhrWindowStart");
      expect(collectSqlText(execute.mock.calls[0]?.[0])).not.toContain("date >");
    });
  });

  describe("trends", () => {
    it("requests processing status for the recovery dataset", async () => {
      processingStatusMock.mockClear();

      await makeCaller([]).trends({ days: 30, endDate: "2024-01-16" });

      expect(processingStatusMock).toHaveBeenCalledWith({ datasets: ["recovery"] });
    });

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
          stddev_steps: 1200,
          stddev_skin_temp: 0.3,
          latest_hrv: 62,
          latest_resting_hr: 53,
          latest_spo2: 98,
          latest_steps: 9000,
          latest_active_energy: 550,
          latest_skin_temp: 36.6,
          sample_count_hrv: 4,
          sample_count_resting_hr: 3,
          sample_count_spo2: 4,
          sample_count_steps: 4,
          sample_count_skin_temp: 4,
          latest_date: "2024-01-16",
          latest_steps_date: "2024-01-16",
          latest_active_energy_date: "2024-01-16",
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.trends({ days: 30, endDate: "2024-01-16" });
      expect(result).toEqual({
        avg_hrv: 60,
        avg_resting_hr: 54,
        avg_spo2: 98,
        avg_steps: 8000,
        avg_skin_temp: 36.5,
        stddev_hrv: 10.5,
        stddev_resting_hr: 2.5,
        stddev_spo2: 0.5,
        stddev_steps: 1200,
        stddev_skin_temp: 0.3,
        latest_hrv: 62,
        latest_resting_hr: 53,
        latest_spo2: 98,
        latest_steps: 9000,
        latest_skin_temp: 36.6,
        sample_count_hrv: 4,
        sample_count_resting_hr: 3,
        sample_count_spo2: 4,
        sample_count_steps: 4,
        sample_count_skin_temp: 4,
        latest_date: "2024-01-16",
        latest_steps_date: "2024-01-16",
        restingHeartRateTrendLabel: "below average",
        baselineRelative: [],
        healthStatus: expect.arrayContaining([
          expect.objectContaining({
            metric: "steps",
            sampleDeviation: 1200,
            statusToken: "near_baseline",
          }),
        ]),
      });
    });

    it("returns canonical recovery baseline context with aggregate trends", async () => {
      const execute = vi.fn().mockResolvedValue([
        {
          avg_hrv: 60,
          avg_resting_hr: 54,
          avg_spo2: null,
          avg_steps: null,
          avg_skin_temp: null,
          stddev_hrv: 6,
          stddev_resting_hr: 2,
          stddev_spo2: null,
          stddev_steps: null,
          stddev_skin_temp: null,
          latest_hrv: 72,
          latest_resting_hr: 48,
          latest_spo2: null,
          latest_steps: null,
          latest_skin_temp: null,
          sample_count_hrv: 1,
          sample_count_resting_hr: 1,
          sample_count_spo2: 0,
          sample_count_steps: 0,
          sample_count_skin_temp: 0,
          latest_date: "2024-01-16",
          latest_steps_date: null,
        },
      ]);
      const recoveryRow = {
        date: "2024-01-16",
        hrv: 72,
        resting_hr: 48,
        respiratory_rate: 14,
        efficiency_pct: 90,
        hrv_mean_30d: 60,
        hrv_sd_30d: 6,
        hrv_z_score: 2,
        hrv_baseline_sample_count: 1,
        hrv_baseline_coverage: 0.8,
        hrv_mean_7d: 66,
        hrv_mean_previous_28d: 61,
        rhr_mean_30d: 52,
        rhr_sd_30d: 2,
        resting_hr_z_score: -2,
        rhr_baseline_sample_count: 30,
        rhr_baseline_coverage: 1,
        rhr_mean_7d: 49,
        rhr_mean_previous_28d: 53,
        rr_mean_30d: 15,
        rr_sd_30d: 0.5,
        respiratory_rate_z_score: -2,
        rr_baseline_sample_count: 15,
        rr_baseline_coverage: 0.5,
        rr_mean_7d: 14.5,
        rr_mean_previous_28d: 15.2,
        efficiency_mean_30d: 85,
        efficiency_sd_30d: 2.5,
        efficiency_z_score: 2,
        efficiency_baseline_sample_count: 28,
        efficiency_baseline_coverage: 28 / 30,
        efficiency_mean_7d: 88,
        efficiency_mean_previous_28d: 84,
      };
      const sensorStore = makeMockSensorStore([
        [{ date: "2024-01-16", resting_hr: 48 }],
        [recoveryRow],
      ]);
      const caller = createCaller({
        db: { execute },
        sensorStore,
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.trends({ days: 30, endDate: "2024-01-16" });

      expect(result?.baselineRelative).toHaveLength(4);
      expect(result?.baselineRelative[0]).toMatchObject({
        metric: "hrv",
        value: 72,
        baseline: { mean: 60, zScore: 2, sampleCount: 1, coverage: 0.8 },
        comparison: { delta: 5, direction: "increasing" },
      });
      expect(result?.restingHeartRateTrendLabel).toBe("below average");
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
          stddev_steps: "1200",
          stddev_skin_temp: "0.30",
          latest_hrv: 62,
          latest_resting_hr: 53,
          latest_spo2: 98,
          latest_steps: 9000,
          latest_active_energy: 550,
          latest_skin_temp: 36.6,
          sample_count_hrv: 4,
          sample_count_resting_hr: 3,
          sample_count_spo2: 4,
          sample_count_steps: 4,
          sample_count_skin_temp: 4,
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
          stddev_steps: 1200,
          stddev_skin_temp: 0.3,
          latest_hrv: 62,
          latest_resting_hr: 53,
          latest_spo2: 98,
          latest_steps: 9000,
          latest_active_energy: 550,
          latest_skin_temp: 36.6,
          sample_count_hrv: 4,
          sample_count_resting_hr: 3,
          sample_count_spo2: 4,
          sample_count_steps: 4,
          sample_count_skin_temp: 4,
          latest_date: "2024-01-16",
          latest_steps_date: "2024-01-16",
          latest_active_energy_date: "2024-01-16",
        },
      ]);
      const sensorStore = makeMockSensorStore([[{ date: "2024-01-16", resting_hr: 53 }], []]);
      const caller = createCaller({
        db: { execute },
        sensorStore,
        userId: "user-1",
        timezone: "America/Los_Angeles",
      });

      const result = await caller.trends({ days: 30, endDate: "2024-01-16" });

      expect(result?.latest_resting_hr).toBe(53);
      expect(sensorStore.query).toHaveBeenCalledTimes(2);
      const queryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
      const queryParams = vi.mocked(sensorStore.query).mock.calls[0]?.[2];
      expect(queryText).toContain("analytics.resting_heart_rate_sleep_window");
      expect(queryParams).toMatchObject({
        userId: "user-1",
        timezone: "America/Los_Angeles",
        rhrEndDate: "2024-01-16",
        rhrWindowStart: "2023-12-17",
      });
      const baselineQuery = vi.mocked(sensorStore.query).mock.calls[1]?.[1];
      const baselineParams = vi.mocked(sensorStore.query).mock.calls[1]?.[2];
      const baselineOptions = vi.mocked(sensorStore.query).mock.calls[1]?.[3];
      expect(baselineQuery).not.toContain("maxIf(latest.date, latest.hrv IS NOT NULL)");
      expect(baselineParams).toMatchObject({
        userId: "user-1",
        startDate: "2023-12-18",
        endDate: "2024-01-16",
      });
      expect(baselineOptions).toEqual({ priority: "dashboard" });
    });

    it("omits lower bounds for trend aggregation when days is null", async () => {
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
          stddev_steps: 1200,
          stddev_skin_temp: 0.3,
          latest_hrv: 62,
          latest_resting_hr: 53,
          latest_spo2: 98,
          latest_steps: 9000,
          latest_active_energy: 550,
          latest_skin_temp: 36.6,
          sample_count_hrv: 4,
          sample_count_resting_hr: 3,
          sample_count_spo2: 4,
          sample_count_steps: 4,
          sample_count_skin_temp: 4,
          latest_date: "2024-01-16",
          latest_steps_date: "2024-01-16",
          latest_active_energy_date: "2024-01-16",
        },
      ]);
      const sensorStore = makeMockSensorStore([[{ date: "2024-01-16", resting_hr: 53 }], []]);
      const caller = createCaller({
        db: { execute },
        sensorStore,
        userId: "user-1",
        timezone: "America/Los_Angeles",
      });

      await caller.trends({ days: null, endDate: "2024-01-16" });

      const restingHeartRateQueryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
      const restingHeartRateQueryParams = vi.mocked(sensorStore.query).mock.calls[0]?.[2];
      expect(restingHeartRateQueryText).not.toContain("rhrWindowStart");
      expect(restingHeartRateQueryParams).not.toHaveProperty("rhrWindowStart");
      const queryText = collectSqlText(execute.mock.calls[0]?.[0]);
      expect(queryText).toContain("dm.user_id =");
      expect(queryText).not.toContain("date >");
      expect(queryText).not.toContain("base_dates.date >");
    });

    it("uses the bounded latest-metrics query for baseline context when days is null", async () => {
      const execute = vi.fn().mockResolvedValue([
        {
          avg_hrv: 60,
          avg_resting_hr: 54,
          avg_spo2: null,
          avg_steps: null,
          avg_skin_temp: null,
          stddev_hrv: 6,
          stddev_resting_hr: 2,
          stddev_spo2: null,
          stddev_steps: null,
          stddev_skin_temp: null,
          latest_hrv: 72,
          latest_resting_hr: 48,
          latest_spo2: null,
          latest_steps: null,
          latest_skin_temp: null,
          sample_count_hrv: 1,
          sample_count_resting_hr: 1,
          sample_count_spo2: 0,
          sample_count_steps: 0,
          sample_count_skin_temp: 0,
          latest_date: "2024-01-16",
          latest_steps_date: null,
        },
      ]);
      const sensorStore = makeMockSensorStore([[{ date: "2024-01-16", resting_hr: 48 }], []]);
      const caller = createCaller({
        db: { execute },
        sensorStore,
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.trends({ days: null, endDate: "2024-01-16" });

      const baselineQuery = vi.mocked(sensorStore.query).mock.calls[1]?.[1];
      const baselineParams = vi.mocked(sensorStore.query).mock.calls[1]?.[2];
      const baselineOptions = vi.mocked(sensorStore.query).mock.calls[1]?.[3];
      expect(baselineQuery).toContain("maxIf(latest.date, latest.hrv IS NOT NULL)");
      expect(baselineQuery).not.toContain("startDate");
      expect(baselineParams).toMatchObject({
        userId: "user-1",
        endDate: "2024-01-16",
      });
      expect(baselineOptions).toEqual({ priority: "dashboard" });
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
