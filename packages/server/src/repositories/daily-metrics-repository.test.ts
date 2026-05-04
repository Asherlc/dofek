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
    hrv: 45,
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
    mean_60d: "42.5",
    sd_60d: "8.3",
    mean_7d: "44.1",
    ...overrides,
  };
}

function makeTrendsRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    avg_hrv: "43.8",
    avg_spo2: "97.1",
    avg_steps: "8200",
    avg_active_energy: "410",
    avg_skin_temp: "33.0",
    stddev_hrv: "7.5",
    stddev_spo2: "0.8",
    stddev_skin_temp: "0.4",
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

function makeAllNullTrendsRow(): Record<string, unknown> {
  return {
    avg_hrv: null,
    avg_spo2: null,
    avg_steps: null,
    avg_active_energy: null,
    avg_skin_temp: null,
    stddev_hrv: null,
    stddev_spo2: null,
    stddev_skin_temp: null,
    latest_hrv: null,
    latest_spo2: null,
    latest_steps: null,
    latest_active_energy: null,
    latest_skin_temp: null,
    latest_date: null,
    latest_steps_date: null,
    latest_active_energy_date: null,
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

    it("returns empty when view returns empty (plain view has no refresh)", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.list(30, "2025-03-15");
      expect(result).toEqual([]);
    });

    it("returns view data as-is since plain views always show current data", async () => {
      // With plain views, the view always shows current data from the base table.
      // There's no refresh mechanism - the view is just a stored query.
      const row = makeDailyMetricsRow({ date: "2025-03-15", steps: 8500 });
      const { repo, execute } = makeRepository([row]);
      const result = await repo.list(30, "2025-03-15");
      expect(result).toHaveLength(1);
      expect(result[0]?.steps).toBe(8500);
      // Only one query expected - no staleness checks for plain views
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("does not refresh when view data is recent (within 1 day of endDate)", async () => {
      const recentRow = makeDailyMetricsRow({ date: "2025-03-14" });
      const { repo, execute } = makeRepository([recentRow]);
      const result = await repo.list(30, "2025-03-15");
      expect(result).toHaveLength(1);
      // Only one query — no base table check
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("returns data from view (plain view has no staleness checks)", async () => {
      const row = makeDailyMetricsRow({ date: "2025-03-10" });
      const { repo, execute } = makeRepository([row]);
      const result = await repo.list(30, "2025-03-15");
      expect(result).toHaveLength(1);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("returns data from view (plain view has no staleness checks)", async () => {
      const row = makeDailyMetricsRow({ date: "2025-03-10" });
      const { repo, execute } = makeRepository([row]);
      const result = await repo.list(30, "2025-03-15");
      expect(result).toHaveLength(1);
      expect(result[0]?.date).toBe("2025-03-10");
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("returns data with null steps when view has null steps (plain view shows current data)", async () => {
      // With plain views, the view always shows current data from the base table.
      // If steps are null in the view, they're null in the base table too.
      const rowWithoutSteps = makeDailyMetricsRow({
        date: "2025-03-15",
        steps: null,
        active_energy_kcal: null,
      });
      const { repo, execute } = makeRepository([rowWithoutSteps]);
      const result = await repo.list(30, "2025-03-15");
      expect(result).toHaveLength(1);
      expect(result[0]?.steps).toBeNull();
      expect(execute).toHaveBeenCalledTimes(1);
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

    it("returns rows with null steps when view has null steps", async () => {
      // With plain views, if the view has null steps, that's the current data
      const rowNoSteps = makeDailyMetricsRow({
        date: "2025-03-15",
        steps: null,
        active_energy_kcal: null,
      });
      const { repo, execute } = makeRepository([rowNoSteps]);
      const result = await repo.list(30, "2025-03-15");
      expect(result).toHaveLength(1);
      expect(result[0]?.steps).toBeNull();
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("returns multiple rows from view", async () => {
      const olderRow = makeDailyMetricsRow({
        date: "2025-03-14",
        steps: 7800,
        active_energy_kcal: 390,
      });
      const latestRow = makeDailyMetricsRow({
        date: "2025-03-15",
        steps: null,
        active_energy_kcal: null,
      });
      const { repo, execute } = makeRepository([olderRow, latestRow]);

      const result = await repo.list(30, "2025-03-15");

      expect(result).toHaveLength(2);
      expect(result[1]?.steps).toBeNull();
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("returns empty when view is empty", async () => {
      const { repo, execute } = makeRepository([]);
      const result = await repo.list(30, "2025-03-15");
      expect(result).toEqual([]);
      expect(execute).toHaveBeenCalledTimes(1);
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

    it("does not log warning when trends returns all nulls (plain view has no refresh)", async () => {
      // With plain views, there's no concept of a "stale view" since
      // the view always shows current data from the base table.
      const allNullRow = makeAllNullTrendsRow();
      const { repo } = makeRepository([allNullRow]);
      await repo.getTrends(30, "2025-03-15");
      expect(mockLoggerWarn).not.toHaveBeenCalled();
    });

    it("does not log warning when trends returns all nulls (plain view has no refresh)", async () => {
      const { repo } = makeRepository([makeAllNullTrendsRow()]);
      await repo.getTrends(30, "2025-03-15");
      expect(mockLoggerWarn).not.toHaveBeenCalled();
    });

    it("returns all-null trends when view returns all nulls", async () => {
      const { repo } = makeRepository([makeAllNullTrendsRow()]);
      const result = await repo.getTrends(30, "2025-03-15");
      expect(result?.avg_hrv).toBeNull();
      expect(result?.latest_date).toBeNull();
    });

    it("does not log warning when trends has data", async () => {
      const { repo, execute } = makeRepository([makeTrendsRow()]);
      await repo.getTrends(30, "2025-03-15");
      expect(mockLoggerWarn).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("returns null latest steps when trends has null latest steps (plain view shows current data)", async () => {
      const staleRow = makeTrendsRow({
        avg_steps: "8200",
        latest_steps: null,
        latest_active_energy: null,
        latest_date: "2025-03-15",
      });
      const { repo, execute } = makeRepository([staleRow]);

      const result = await repo.getTrends(30, "2025-03-15");

      expect(result?.latest_steps).toBeNull();
      expect(execute).toHaveBeenCalledTimes(1);
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

    it("returns old metric dates when view has old metric dates (plain view shows current data)", async () => {
      const staleMetricDatesRow = makeTrendsRow({
        latest_date: "2025-03-15",
        latest_steps: "9100",
        latest_steps_date: "2025-03-13",
        latest_active_energy: "430",
        latest_active_energy_date: "2025-03-13",
      });
      const { repo, execute } = makeRepository([staleMetricDatesRow]);

      const result = await repo.getTrends(30, "2025-03-15");

      expect(result?.latest_steps).toBe(9100);
      expect(result?.latest_steps_date).toBe("2025-03-13");
      expect(result?.latest_active_energy).toBe(430);
      expect(execute).toHaveBeenCalledTimes(1);
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
      const { repo } = makeRepository([makeAllNullTrendsRow()]);
      const result = await repo.getTrends(30, "2025-03-15");
      expect(result).not.toBeNull();
      expect(result?.avg_hrv).toBeNull();
      expect(result?.latest_date).toBeNull();
    });
  });
});
