import { beforeEach, describe, expect, it, vi } from "vitest";
import { DailyMetricsRepository } from "./daily-metrics-repository.ts";

const mockLoggerWarn = vi.hoisted(() => vi.fn());

const mockSentryCapture = vi.hoisted(() => vi.fn());

vi.mock("../logger.ts", () => ({
  logger: { warn: mockLoggerWarn, info: vi.fn(), error: vi.fn() },
}));

vi.mock("@sentry/node", () => ({
  captureMessage: mockSentryCapture,
  captureException: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepository(rows: Record<string, unknown>[] = []) {
  const execute = vi.fn().mockResolvedValue(rows);
  const repo = new DailyMetricsRepository({ execute }, "user-1");
  return { repo, execute };
}

function makeDailyMetricsRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    date: "2025-03-15",
    user_id: "user-1",
    resting_hr: 58,
    hrv: 45,
    vo2max: 48.2,
    spo2_avg: 97.5,
    respiratory_rate_avg: 14.2,
    skin_temp_c: 33.1,
    steps: 8500,
    active_energy_kcal: 420,
    basal_energy_kcal: 1600,
    distance_km: 6.2,
    flights_climbed: 8,
    exercise_minutes: 45,
    stand_hours: 10,
    walking_speed: 5.1,
    source_providers: ["apple_health", "whoop"],
    ...overrides,
  };
}

function makeHrvBaselineRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    date: "2025-03-15",
    hrv: "45",
    resting_hr: "58",
    mean_60d: "42.5",
    sd_60d: "8.3",
    mean_7d: "44.1",
    ...overrides,
  };
}

function makeTrendsRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    avg_resting_hr: "57.2",
    avg_hrv: "43.8",
    avg_spo2: "97.1",
    avg_steps: "8200",
    avg_active_energy: "410",
    avg_skin_temp: "33.0",
    stddev_resting_hr: "3.1",
    stddev_hrv: "7.5",
    stddev_spo2: "0.8",
    stddev_skin_temp: "0.4",
    latest_resting_hr: "56",
    latest_hrv: "48",
    latest_spo2: "98",
    latest_steps: "9200",
    latest_active_energy: "450",
    latest_skin_temp: "33.2",
    latest_date: "2025-03-15",
    latest_steps_date: "2025-03-15",
    latest_active_energy_date: "2025-03-15",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DailyMetricsRepository", () => {
  beforeEach(() => {
    mockLoggerWarn.mockClear();
    mockSentryCapture.mockClear();
  });

  describe("list", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      expect(await repo.list(30, "2025-03-15")).toEqual([]);
    });

    it("returns parsed rows", async () => {
      const { repo } = makeRepository([makeDailyMetricsRow()]);
      const result = await repo.list(30, "2025-03-15");
      expect(result).toHaveLength(1);
      expect(result[0]?.date).toBe("2025-03-15");
      expect(result[0]?.hrv).toBe(45);
      expect(result[0]?.source_providers).toEqual(["apple_health", "whoop"]);
    });

    it("calls execute once when view has data", async () => {
      const { repo, execute } = makeRepository([makeDailyMetricsRow()]);
      await repo.list(30, "2025-03-15");
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("refreshes view and retries when view returns empty but base table has data", async () => {
      const execute = vi
        .fn()
        // First call: list query returns empty (stale view)
        .mockResolvedValueOnce([])
        // Second call: base table existence check — has data
        .mockResolvedValueOnce([{ exists: 1 }])
        // Third call: REFRESH MATERIALIZED VIEW (succeeds)
        .mockResolvedValueOnce([])
        // Fourth call: retry list query — returns data
        .mockResolvedValueOnce([makeDailyMetricsRow()]);
      const repo = new DailyMetricsRepository({ execute }, "user-1");
      const result = await repo.list(30, "2025-03-15");
      expect(result).toHaveLength(1);
      expect(result[0]?.steps).toBe(8500);
      expect(mockSentryCapture).toHaveBeenCalledWith(
        expect.stringContaining("Stale daily metrics"),
        expect.anything(),
      );
    });

    it("refreshes view when results are stale (base table has newer data)", async () => {
      const staleRow = makeDailyMetricsRow({ date: "2025-03-10", steps: null });
      const freshRow = makeDailyMetricsRow({ date: "2025-03-15", steps: 9200 });
      const execute = vi
        .fn()
        // First call: list query returns stale data (5 days behind endDate)
        .mockResolvedValueOnce([staleRow])
        // Second call: base table existence check — has newer rows
        .mockResolvedValueOnce([{ exists: 1 }])
        // Third call: REFRESH MATERIALIZED VIEW (succeeds)
        .mockResolvedValueOnce([])
        // Fourth call: retry list query — returns fresh data
        .mockResolvedValueOnce([staleRow, freshRow]);
      const repo = new DailyMetricsRepository({ execute }, "user-1");
      const result = await repo.list(30, "2025-03-15");
      expect(result).toHaveLength(2);
      expect(result[1]?.steps).toBe(9200);
      expect(execute).toHaveBeenCalledTimes(4);
    });

    it("does not refresh when view data is recent (within 1 day of endDate)", async () => {
      const recentRow = makeDailyMetricsRow({ date: "2025-03-14" });
      const { repo, execute } = makeRepository([recentRow]);
      const result = await repo.list(30, "2025-03-15");
      expect(result).toHaveLength(1);
      // Only one query — no base table check
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("does not refresh stale view when base table also has no newer data", async () => {
      const staleRow = makeDailyMetricsRow({ date: "2025-03-10" });
      const execute = vi
        .fn()
        // First call: list query returns stale data
        .mockResolvedValueOnce([staleRow])
        // Second call: base table existence check — no newer data
        .mockResolvedValueOnce([]);
      const repo = new DailyMetricsRepository({ execute }, "user-1");
      const result = await repo.list(30, "2025-03-15");
      expect(result).toHaveLength(1);
      // No refresh attempted — only view query + base table check
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it("returns stale data when refresh fails on stale view", async () => {
      const staleRow = makeDailyMetricsRow({ date: "2025-03-10" });
      const execute = vi
        .fn()
        // First call: list query returns stale data
        .mockResolvedValueOnce([staleRow])
        // Second call: base table existence check — has newer rows
        .mockResolvedValueOnce([{ exists: 1 }])
        // Third call: CONCURRENT refresh fails
        .mockRejectedValueOnce(new Error("CONCURRENT failed"))
        // Fourth call: regular refresh also fails
        .mockRejectedValueOnce(new Error("regular also failed"));
      const repo = new DailyMetricsRepository({ execute }, "user-1");
      const result = await repo.list(30, "2025-03-15");
      // Returns the stale data rather than nothing
      expect(result).toHaveLength(1);
      expect(result[0]?.date).toBe("2025-03-10");
    });

    it("refreshes view when steps/energy are null in view but present in base table (column-level staleness)", async () => {
      // Scenario: Garmin synced HRV for today, so view has recent dates,
      // but Apple Health steps arrived after the last view refresh.
      // Steps are null in the view but non-null in the base table.
      const rowWithoutSteps = makeDailyMetricsRow({
        date: "2025-03-15",
        steps: null,
        active_energy_kcal: null,
      });
      const rowWithSteps = makeDailyMetricsRow({
        date: "2025-03-15",
        steps: 9200,
        active_energy_kcal: 420,
      });
      const execute = vi
        .fn()
        // First call: list query — returns data but steps are null
        .mockResolvedValueOnce([rowWithoutSteps])
        // Second call: base table check for missing metrics — has step data
        .mockResolvedValueOnce([{ exists: 1 }])
        // Third call: REFRESH MATERIALIZED VIEW CONCURRENTLY
        .mockResolvedValueOnce([])
        // Fourth call: retry list query — now has steps
        .mockResolvedValueOnce([rowWithSteps]);
      const repo = new DailyMetricsRepository({ execute }, "user-1");
      const result = await repo.list(30, "2025-03-15");
      expect(result).toHaveLength(1);
      expect(result[0]?.steps).toBe(9200);
      expect(mockSentryCapture).toHaveBeenCalledWith(
        expect.stringContaining("Stale daily metrics"),
        expect.objectContaining({
          extra: expect.objectContaining({
            reason: expect.stringContaining("missing metrics"),
          }),
        }),
      );
    });

    it("does not check missing metrics when key metrics have data in view", async () => {
      // Steps are present in view — no column-level staleness check needed
      const rowWithSteps = makeDailyMetricsRow({ date: "2025-03-15", steps: 8500 });
      const { repo, execute } = makeRepository([rowWithSteps]);
      const result = await repo.list(30, "2025-03-15");
      expect(result).toHaveLength(1);
      // Only one query — no base table check for missing metrics
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("does not refresh when key metrics are null in both view and base table", async () => {
      // User has no step data at all — no false positive
      const rowNoSteps = makeDailyMetricsRow({
        date: "2025-03-15",
        steps: null,
        active_energy_kcal: null,
      });
      const execute = vi
        .fn()
        // First call: list query — steps null
        .mockResolvedValueOnce([rowNoSteps])
        // Second call: latest-date check — also no steps
        .mockResolvedValueOnce([])
        // Third call: full-window check — also no steps
        .mockResolvedValueOnce([]);
      const repo = new DailyMetricsRepository({ execute }, "user-1");
      const result = await repo.list(30, "2025-03-15");
      expect(result).toHaveLength(1);
      expect(result[0]?.steps).toBeNull();
      // No refresh attempted — view query + latest-date check + window check
      expect(execute).toHaveBeenCalledTimes(3);
      expect(mockSentryCapture).not.toHaveBeenCalled();
    });

    it("refreshes view when the latest row is missing steps but the base table has steps for that date", async () => {
      const olderRowWithSteps = makeDailyMetricsRow({
        date: "2025-03-14",
        steps: 7800,
        active_energy_kcal: 390,
      });
      const latestRowWithoutSteps = makeDailyMetricsRow({
        date: "2025-03-15",
        steps: null,
        active_energy_kcal: null,
      });
      const refreshedLatestRow = makeDailyMetricsRow({
        date: "2025-03-15",
        steps: 9200,
        active_energy_kcal: 430,
      });
      const execute = vi
        .fn()
        .mockResolvedValueOnce([olderRowWithSteps, latestRowWithoutSteps])
        .mockResolvedValueOnce([{ exists: 1 }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([olderRowWithSteps, refreshedLatestRow]);
      const repo = new DailyMetricsRepository({ execute }, "user-1");

      const result = await repo.list(30, "2025-03-15");

      expect(result).toHaveLength(2);
      expect(result[1]?.steps).toBe(9200);
      expect(mockSentryCapture).toHaveBeenCalledWith(
        expect.stringContaining("Stale daily metrics"),
        expect.objectContaining({
          extra: expect.objectContaining({
            reason: expect.stringContaining("latest row"),
          }),
        }),
      );
    });

    it("returns empty when both view and base table are empty", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // view empty
        .mockResolvedValueOnce([]); // base table existence check — empty
      const repo = new DailyMetricsRepository({ execute }, "user-1");
      const result = await repo.list(30, "2025-03-15");
      expect(result).toEqual([]);
      // Should NOT attempt refresh
      expect(execute).toHaveBeenCalledTimes(2);
    });
  });

  describe("getLatest", () => {
    it("returns null when no data", async () => {
      const { repo } = makeRepository([]);
      expect(await repo.getLatest()).toBeNull();
    });

    it("returns the single row", async () => {
      const { repo } = makeRepository([makeDailyMetricsRow({ date: "2025-03-14" })]);
      const result = await repo.getLatest();
      expect(result).not.toBeNull();
      expect(result?.date).toBe("2025-03-14");
    });
  });

  describe("getHrvBaseline", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      expect(await repo.getHrvBaseline(30, "2025-03-15")).toEqual([]);
    });

    it("returns parsed baseline rows", async () => {
      const { repo } = makeRepository([makeHrvBaselineRow()]);
      const result = await repo.getHrvBaseline(30, "2025-03-15");
      expect(result).toHaveLength(1);
      expect(result[0]?.mean_60d).toBe(42.5);
      expect(result[0]?.sd_60d).toBe(8.3);
      expect(result[0]?.mean_7d).toBe(44.1);
    });

    it("filters out warmup rows before the cutoff date", async () => {
      // Request 30 days ending 2025-03-15, cutoff = 2025-02-13
      // Warmup row on 2025-01-20 should be excluded (before cutoff)
      // Row on 2025-02-12 should be excluded (before cutoff)
      // Row on 2025-02-13 is included (>= cutoff)
      const { repo } = makeRepository([
        makeHrvBaselineRow({ date: "2025-01-20" }),
        makeHrvBaselineRow({ date: "2025-02-12" }),
        makeHrvBaselineRow({ date: "2025-02-13" }),
        makeHrvBaselineRow({ date: "2025-03-15" }),
      ]);
      const result = await repo.getHrvBaseline(30, "2025-03-15");
      expect(result).toHaveLength(2);
      expect(result[0]?.date).toBe("2025-02-13");
      expect(result[1]?.date).toBe("2025-03-15");
    });

    it("handles null HRV values in baseline rows", async () => {
      const { repo } = makeRepository([
        makeHrvBaselineRow({ hrv: null, mean_60d: null, sd_60d: null, mean_7d: null }),
      ]);
      const result = await repo.getHrvBaseline(30, "2025-03-15");
      expect(result).toHaveLength(1);
      expect(result[0]?.hrv).toBeNull();
      expect(result[0]?.mean_60d).toBeNull();
    });
  });

  describe("getTrends", () => {
    it("returns null when no data", async () => {
      const { repo } = makeRepository([]);
      expect(await repo.getTrends(30, "2025-03-15")).toBeNull();
    });

    it("returns parsed trends", async () => {
      const { repo, execute } = makeRepository([makeTrendsRow()]);
      const result = await repo.getTrends(30, "2025-03-15");
      expect(result).not.toBeNull();
      expect(result?.avg_hrv).toBe(43.8);
      expect(result?.latest_hrv).toBe(48);
      expect(result?.latest_date).toBe("2025-03-15");
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("logs warning when trends returns all nulls but base table has data (stale view)", async () => {
      const allNullRow = makeTrendsRow({ avg_resting_hr: null, latest_date: null });
      const execute = vi
        .fn()
        // First call: trends query returns all nulls
        .mockResolvedValueOnce([allNullRow])
        // Second call: base table existence check — has data
        .mockResolvedValueOnce([{ exists: 1 }])
        // Third call: REFRESH MATERIALIZED VIEW
        .mockResolvedValueOnce([])
        // Fourth call: retry trends query (still null — view may still be stale)
        .mockResolvedValueOnce([allNullRow]);
      const repo = new DailyMetricsRepository({ execute }, "user-1");
      await repo.getTrends(30, "2025-03-15");
      expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("View stale"));
    });

    it("does not log warning when trends returns all nulls and base table is empty (new user)", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([makeTrendsRow({ avg_resting_hr: null, latest_date: null })])
        .mockResolvedValueOnce([]); // base table existence check — empty
      const repo = new DailyMetricsRepository({ execute }, "user-1");
      await repo.getTrends(30, "2025-03-15");
      expect(mockLoggerWarn).not.toHaveBeenCalled();
    });

    it("refreshes view and retries when trends all null but base table has data", async () => {
      const allNullRow = makeTrendsRow({ avg_resting_hr: null, latest_date: null });
      const populatedRow = makeTrendsRow();
      const execute = vi
        .fn()
        // First call: trends query returns all-null (stale view)
        .mockResolvedValueOnce([allNullRow])
        // Second call: base table existence check — has data
        .mockResolvedValueOnce([{ exists: 1 }])
        // Third call: REFRESH MATERIALIZED VIEW (succeeds)
        .mockResolvedValueOnce([])
        // Fourth call: retry trends query — returns data
        .mockResolvedValueOnce([populatedRow]);
      const repo = new DailyMetricsRepository({ execute }, "user-1");
      const result = await repo.getTrends(30, "2025-03-15");
      expect(result?.avg_resting_hr).toBe(57.2);
      expect(result?.latest_date).toBe("2025-03-15");
      expect(mockSentryCapture).toHaveBeenCalledWith(
        expect.stringContaining("Stale daily metrics"),
        expect.anything(),
      );
    });

    it("does not log warning when trends has data", async () => {
      const { repo, execute } = makeRepository([makeTrendsRow()]);
      await repo.getTrends(30, "2025-03-15");
      expect(mockLoggerWarn).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("refreshes trends when latest steps are null but the base table has steps for the latest date", async () => {
      const staleRow = makeTrendsRow({
        avg_steps: "8200",
        latest_steps: null,
        latest_active_energy: null,
        latest_date: "2025-03-15",
      });
      const refreshedRow = makeTrendsRow({
        avg_steps: "8300",
        latest_steps: "9400",
        latest_active_energy: "460",
        latest_date: "2025-03-15",
      });
      const execute = vi
        .fn()
        .mockResolvedValueOnce([staleRow])
        .mockResolvedValueOnce([{ exists: 1 }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([refreshedRow]);
      const repo = new DailyMetricsRepository({ execute }, "user-1");

      const result = await repo.getTrends(30, "2025-03-15");

      expect(result?.latest_steps).toBe(9400);
      expect(mockSentryCapture).toHaveBeenCalledWith(
        expect.stringContaining("Stale daily metrics"),
        expect.objectContaining({
          extra: expect.objectContaining({
            reason: expect.stringContaining("latest trends"),
          }),
        }),
      );
    });

    it("does not check latest missing metrics when the trends row has no latest date", async () => {
      const rowWithoutLatestDate = makeTrendsRow({
        latest_steps: null,
        latest_active_energy: null,
        latest_date: null,
        latest_steps_date: null,
        latest_active_energy_date: null,
      });
      const { repo, execute } = makeRepository([rowWithoutLatestDate]);

      const result = await repo.getTrends(30, "2025-03-15");

      expect(result?.latest_date).toBeNull();
      expect(result?.latest_steps).toBeNull();
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("refreshes trends when latest metric dates are older than the end date but base table has newer data", async () => {
      const staleMetricDatesRow = makeTrendsRow({
        latest_date: "2025-03-15",
        latest_steps: "9100",
        latest_steps_date: "2025-03-13",
        latest_active_energy: "430",
        latest_active_energy_date: "2025-03-13",
      });
      const refreshedRow = makeTrendsRow({
        latest_date: "2025-03-15",
        latest_steps: "9400",
        latest_steps_date: "2025-03-15",
        latest_active_energy: "460",
        latest_active_energy_date: "2025-03-15",
      });
      const execute = vi
        .fn()
        .mockResolvedValueOnce([staleMetricDatesRow])
        .mockResolvedValueOnce([{ exists: 1 }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([refreshedRow]);
      const repo = new DailyMetricsRepository({ execute }, "user-1");

      const result = await repo.getTrends(30, "2025-03-15");

      expect(result?.latest_steps).toBe(9400);
      expect(result?.latest_steps_date).toBe("2025-03-15");
      expect(result?.latest_active_energy).toBe(460);
      expect(mockSentryCapture).toHaveBeenCalledWith(
        expect.stringContaining("Stale daily metrics"),
        expect.objectContaining({
          extra: expect.objectContaining({
            reason: expect.stringContaining("outdated"),
          }),
        }),
      );
    });

    it("returns latest values from most recent day in window when endDate has no data", async () => {
      // Simulates: stats are populated (data in 30-day window) but latest comes
      // from yesterday, not today — the query should use the most recent row
      // in the window rather than requiring an exact endDate match.
      const { repo, execute } = makeRepository([makeTrendsRow({ latest_date: "2025-03-14" })]);
      const result = await repo.getTrends(30, "2025-03-15");
      expect(result).not.toBeNull();
      expect(result?.latest_date).toBe("2025-03-14");
      expect(result?.latest_hrv).toBe(48);
      expect(result?.avg_hrv).toBe(43.8);

      // Verify the SQL uses a "latest" CTE to derive latest non-null values
      // instead of requiring an exact date match on endDate.
      const sqlArg = execute.mock.calls[0]?.[0];
      const sqlText = JSON.stringify(sqlArg);
      expect(sqlText).toContain("latest");
      expect(sqlText).toContain("ARRAY_AGG");
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("handles all-null trends row", async () => {
      const allNullTrends = makeTrendsRow({
        avg_resting_hr: null,
        avg_hrv: null,
        avg_spo2: null,
        avg_steps: null,
        avg_active_energy: null,
        avg_skin_temp: null,
        stddev_resting_hr: null,
        stddev_hrv: null,
        stddev_spo2: null,
        stddev_skin_temp: null,
        latest_resting_hr: null,
        latest_hrv: null,
        latest_spo2: null,
        latest_steps: null,
        latest_active_energy: null,
        latest_skin_temp: null,
        latest_date: null,
      });
      const execute = vi.fn().mockResolvedValueOnce([allNullTrends]).mockResolvedValueOnce([]); // base table existence check (new user — empty)
      const repo = new DailyMetricsRepository({ execute }, "user-1");
      const result = await repo.getTrends(30, "2025-03-15");
      expect(result).not.toBeNull();
      expect(result?.avg_hrv).toBeNull();
      expect(result?.latest_date).toBeNull();
    });
  });
});
