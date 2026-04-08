import { describe, expect, it, vi } from "vitest";
import { DailyMetricsRepository } from "./daily-metrics-repository.ts";

const mockLoggerWarn = vi.hoisted(() => vi.fn());

vi.mock("../logger.ts", () => ({
  logger: { warn: mockLoggerWarn, info: vi.fn(), error: vi.fn() },
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DailyMetricsRepository", () => {
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

    it("calls execute once", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.list(30, "2025-03-15");
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
      const { repo } = makeRepository([makeTrendsRow()]);
      const result = await repo.getTrends(30, "2025-03-15");
      expect(result).not.toBeNull();
      expect(result?.avg_hrv).toBe(43.8);
      expect(result?.latest_hrv).toBe(48);
      expect(result?.latest_date).toBe("2025-03-15");
    });

    it("logs warning when trends returns all nulls (stale view)", async () => {
      mockLoggerWarn.mockClear();
      const { repo } = makeRepository([
        makeTrendsRow({
          avg_resting_hr: null,
          latest_date: null,
        }),
      ]);
      await repo.getTrends(30, "2025-03-15");
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining("Trends query returned all nulls"),
      );
    });

    it("does not log warning when trends has data", async () => {
      mockLoggerWarn.mockClear();
      const { repo } = makeRepository([makeTrendsRow()]);
      await repo.getTrends(30, "2025-03-15");
      expect(mockLoggerWarn).not.toHaveBeenCalled();
    });

    it("handles all-null trends row", async () => {
      const { repo } = makeRepository([
        makeTrendsRow({
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
        }),
      ]);
      const result = await repo.getTrends(30, "2025-03-15");
      expect(result).not.toBeNull();
      expect(result?.avg_hrv).toBeNull();
      expect(result?.latest_date).toBeNull();
    });
  });
});
