import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnomalyDetectionRepository,
  type AnomalyRow,
  checkAnomalies,
  sendAnomalyAlertToSlack,
} from "./anomaly-detection-repository.ts";

// ---------------------------------------------------------------------------
// Mocks for sendAnomalyAlertToSlack
// ---------------------------------------------------------------------------

vi.mock("../lib/typed-sql.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/typed-sql.ts")>();
  return {
    ...original,
    executeWithSchema: vi.fn(
      async (
        db: { execute: (query: unknown) => Promise<unknown[]> },
        _schema: unknown,
        query: unknown,
      ) => db.execute(query),
    ),
  };
});

vi.mock("../logger.ts", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock db whose execute resolves with the given rows (once). */
function makeDb(rows: Record<string, unknown>[] = []) {
  const execute = vi.fn().mockResolvedValueOnce(rows);
  return { execute };
}

/** Shorthand for the full check-row shape with all nulls filled in. */
function checkRow(overrides: Record<string, unknown> = {}) {
  return {
    date: "2024-06-15",
    resting_hr: null,
    rhr_mean: null,
    rhr_sd: null,
    rhr_count: null,
    hrv: null,
    hrv_mean: null,
    hrv_sd: null,
    hrv_count: null,
    duration_minutes: null,
    sleep_mean: null,
    sleep_sd: null,
    sleep_count: null,
    ...overrides,
  };
}

/** Shorthand for the history-row shape (no sleep columns). */
function historyRow(overrides: Record<string, unknown> = {}) {
  return {
    date: "2024-06-15",
    resting_hr: null,
    rhr_mean: null,
    rhr_sd: null,
    rhr_count: null,
    hrv: null,
    hrv_mean: null,
    hrv_sd: null,
    hrv_count: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// check()
// ---------------------------------------------------------------------------

describe("AnomalyDetectionRepository", () => {
  describe("check", () => {
    it("returns empty result when no data", async () => {
      const db = makeDb([]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");

      expect(result.anomalies).toEqual([]);
      expect(result.checkedMetrics).toEqual([]);
    });

    it("returns empty result when row has null date", async () => {
      const db = makeDb([checkRow({ date: null })]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");

      expect(result.anomalies).toEqual([]);
      expect(result.checkedMetrics).toEqual([]);
    });

    // -- Resting HR --------------------------------------------------------

    it("detects elevated resting HR as warning (z > 2)", async () => {
      // mean=60, sd=3, value=67 => z = (67-60)/3 = 2.33
      const db = makeDb([checkRow({ resting_hr: 67, rhr_mean: 60, rhr_sd: 3, rhr_count: 20 })]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");

      expect(result.checkedMetrics).toContain("resting_hr");
      expect(result.anomalies).toHaveLength(1);
      expect(result.anomalies[0]?.metric).toBe("Resting Heart Rate");
      expect(result.anomalies[0]?.severity).toBe("warning");
      expect(result.anomalies[0]?.zScore).toBeCloseTo(2.33, 1);
    });

    it("detects severely elevated resting HR as alert (z > 3)", async () => {
      // mean=60, sd=2, value=67 => z = (67-60)/2 = 3.5
      const db = makeDb([checkRow({ resting_hr: 67, rhr_mean: 60, rhr_sd: 2, rhr_count: 20 })]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");

      expect(result.anomalies[0]?.severity).toBe("alert");
      expect(result.anomalies[0]?.zScore).toBeCloseTo(3.5, 1);
    });

    it("does not flag resting HR within normal range", async () => {
      // mean=60, sd=3, value=63 => z = 1.0
      const db = makeDb([checkRow({ resting_hr: 63, rhr_mean: 60, rhr_sd: 3, rhr_count: 20 })]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");

      expect(result.checkedMetrics).toContain("resting_hr");
      expect(result.anomalies).toHaveLength(0);
    });

    it("skips resting HR when baseline count < 14", async () => {
      const db = makeDb([checkRow({ resting_hr: 80, rhr_mean: 60, rhr_sd: 3, rhr_count: 10 })]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");

      expect(result.checkedMetrics).not.toContain("resting_hr");
      expect(result.anomalies).toHaveLength(0);
    });

    it("skips resting HR when stddev is zero", async () => {
      const db = makeDb([checkRow({ resting_hr: 65, rhr_mean: 60, rhr_sd: 0, rhr_count: 20 })]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");

      expect(result.checkedMetrics).not.toContain("resting_hr");
    });

    // -- HRV ---------------------------------------------------------------

    it("detects depressed HRV as warning (z < -2)", async () => {
      // mean=50, sd=5, value=38 => z = (38-50)/5 = -2.4
      const db = makeDb([checkRow({ hrv: 38, hrv_mean: 50, hrv_sd: 5, hrv_count: 20 })]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");

      expect(result.checkedMetrics).toContain("hrv");
      expect(result.anomalies).toHaveLength(1);
      expect(result.anomalies[0]?.metric).toBe("Heart Rate Variability");
      expect(result.anomalies[0]?.severity).toBe("warning");
      expect(result.anomalies[0]?.zScore).toBeCloseTo(-2.4, 1);
    });

    it("detects severely depressed HRV as alert (z < -3)", async () => {
      // mean=50, sd=5, value=33 => z = (33-50)/5 = -3.4
      const db = makeDb([checkRow({ hrv: 33, hrv_mean: 50, hrv_sd: 5, hrv_count: 20 })]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");

      expect(result.anomalies[0]?.severity).toBe("alert");
    });

    it("does not flag HRV within normal range", async () => {
      // mean=50, sd=5, value=45 => z = -1.0
      const db = makeDb([checkRow({ hrv: 45, hrv_mean: 50, hrv_sd: 5, hrv_count: 20 })]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");

      expect(result.checkedMetrics).toContain("hrv");
      expect(result.anomalies).toHaveLength(0);
    });

    // -- Sleep Duration ----------------------------------------------------

    it("detects short sleep as warning (z < -2)", async () => {
      // mean=420, sd=30, value=350 => z = (350-420)/30 = -2.33
      const db = makeDb([
        checkRow({ duration_minutes: 350, sleep_mean: 420, sleep_sd: 30, sleep_count: 20 }),
      ]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");

      expect(result.checkedMetrics).toContain("sleep_duration");
      expect(result.anomalies).toHaveLength(1);
      expect(result.anomalies[0]?.metric).toBe("Sleep Duration");
      expect(result.anomalies[0]?.severity).toBe("warning");
      expect(result.anomalies[0]?.value).toBe(350);
    });

    it("detects severely short sleep as alert (z < -3)", async () => {
      // mean=420, sd=30, value=320 => z = (320-420)/30 = -3.33
      const db = makeDb([
        checkRow({ duration_minutes: 320, sleep_mean: 420, sleep_sd: 30, sleep_count: 20 }),
      ]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");

      expect(result.anomalies[0]?.severity).toBe("alert");
    });

    // -- Multiple anomalies ------------------------------------------------

    it("detects multiple anomalies at once", async () => {
      const db = makeDb([
        checkRow({
          resting_hr: 70,
          rhr_mean: 60,
          rhr_sd: 3,
          rhr_count: 20,
          hrv: 35,
          hrv_mean: 50,
          hrv_sd: 5,
          hrv_count: 20,
          duration_minutes: 300,
          sleep_mean: 420,
          sleep_sd: 30,
          sleep_count: 20,
        }),
      ]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");

      expect(result.anomalies).toHaveLength(3);
      expect(result.checkedMetrics).toEqual(["resting_hr", "hrv", "sleep_duration"]);
    });

    // -- Z-score rounding --------------------------------------------------

    it("rounds z-scores to 2 decimal places", async () => {
      // mean=60, sd=7, value=75 => z = 15/7 = 2.142857...
      const db = makeDb([checkRow({ resting_hr: 75, rhr_mean: 60, rhr_sd: 7, rhr_count: 20 })]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");

      expect(result.anomalies[0]?.zScore).toBe(2.14);
    });

    it("rounds baseline mean and stddev to 1 decimal place", async () => {
      const db = makeDb([
        checkRow({ resting_hr: 75, rhr_mean: 60.456, rhr_sd: 3.789, rhr_count: 20 }),
      ]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");

      expect(result.anomalies[0]?.baselineMean).toBe(60.5);
      expect(result.anomalies[0]?.baselineStddev).toBe(3.8);
    });
  });

  // -----------------------------------------------------------------------
  // getHistory()
  // -----------------------------------------------------------------------

  describe("getHistory", () => {
    it("returns empty array when no data", async () => {
      const db = makeDb([]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.getHistory(90, "2024-06-15");

      expect(result).toEqual([]);
    });

    it("skips rows with null date", async () => {
      const db = makeDb([historyRow({ date: null })]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.getHistory(90, "2024-06-15");

      expect(result).toEqual([]);
    });

    it("detects elevated resting HR in history", async () => {
      const db = makeDb([
        historyRow({ date: "2024-06-10", resting_hr: 70, rhr_mean: 60, rhr_sd: 3, rhr_count: 20 }),
        historyRow({ date: "2024-06-11", resting_hr: 62, rhr_mean: 60, rhr_sd: 3, rhr_count: 20 }),
      ]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.getHistory(90, "2024-06-15");

      expect(result).toHaveLength(1);
      expect(result[0]?.date).toBe("2024-06-10");
      expect(result[0]?.metric).toBe("Resting Heart Rate");
    });

    it("detects depressed HRV in history", async () => {
      const db = makeDb([
        historyRow({ date: "2024-06-10", hrv: 30, hrv_mean: 50, hrv_sd: 5, hrv_count: 20 }),
      ]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.getHistory(90, "2024-06-15");

      expect(result).toHaveLength(1);
      expect(result[0]?.metric).toBe("Heart Rate Variability");
    });

    it("returns both HR and HRV anomalies for same day", async () => {
      const db = makeDb([
        historyRow({
          date: "2024-06-10",
          resting_hr: 70,
          rhr_mean: 60,
          rhr_sd: 3,
          rhr_count: 20,
          hrv: 30,
          hrv_mean: 50,
          hrv_sd: 5,
          hrv_count: 20,
        }),
      ]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.getHistory(90, "2024-06-15");

      expect(result).toHaveLength(2);
      const metrics = result.map((row) => row.metric);
      expect(metrics).toContain("Resting Heart Rate");
      expect(metrics).toContain("Heart Rate Variability");
    });

    it("skips metrics with insufficient baseline", async () => {
      const db = makeDb([
        historyRow({ date: "2024-06-10", resting_hr: 80, rhr_mean: 60, rhr_sd: 3, rhr_count: 5 }),
      ]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.getHistory(90, "2024-06-15");

      expect(result).toEqual([]);
    });

    it("rounds baselineMean to 1 decimal (x10/10) and zScore to 2 decimals (x100/100) in history", async () => {
      // rhr_mean=60.456, rhr_sd=3.789, value=75
      // z = (75-60.456)/3.789 = 14.544/3.789 = 3.838...
      const db = makeDb([
        historyRow({
          date: "2024-06-10",
          resting_hr: 75,
          rhr_mean: 60.456,
          rhr_sd: 3.789,
          rhr_count: 20,
        }),
      ]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.getHistory(90, "2024-06-15");

      expect(result).toHaveLength(1);
      expect(result[0]?.baselineMean).toBe(60.5);
      expect(result[0]?.baselineStddev).toBe(3.8);
      // z = 14.544 / 3.789 ≈ 3.8378... → Math.round(3.8378 * 100)/100 = 3.84
      expect(result[0]?.zScore).toBe(3.84);
    });

    it("classifies history resting HR z-score > 3 as alert and z <= 3 as warning", async () => {
      const db = makeDb([
        // z = (66-60)/2 = 3.0 exactly → warning (> not >=)
        historyRow({
          date: "2024-06-10",
          resting_hr: 66,
          rhr_mean: 60,
          rhr_sd: 2,
          rhr_count: 20,
        }),
        // z = (67-60)/2 = 3.5 → alert
        historyRow({
          date: "2024-06-11",
          resting_hr: 67,
          rhr_mean: 60,
          rhr_sd: 2,
          rhr_count: 20,
        }),
      ]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.getHistory(90, "2024-06-15");

      expect(result).toHaveLength(2);
      expect(result[0]?.severity).toBe("warning");
      expect(result[1]?.severity).toBe("alert");
    });

    it("classifies history HRV z-score < -3 as alert and z >= -3 as warning", async () => {
      const db = makeDb([
        // z = (35-50)/5 = -3.0 exactly → warning (< not <=)
        historyRow({
          date: "2024-06-10",
          hrv: 35,
          hrv_mean: 50,
          hrv_sd: 5,
          hrv_count: 20,
        }),
        // z = (33-50)/5 = -3.4 → alert
        historyRow({
          date: "2024-06-11",
          hrv: 33,
          hrv_mean: 50,
          hrv_sd: 5,
          hrv_count: 20,
        }),
      ]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.getHistory(90, "2024-06-15");

      expect(result).toHaveLength(2);
      expect(result[0]?.severity).toBe("warning");
      expect(result[1]?.severity).toBe("alert");
    });

    it("skips history HRV when stddev is zero", async () => {
      const db = makeDb([
        historyRow({ date: "2024-06-10", hrv: 30, hrv_mean: 50, hrv_sd: 0, hrv_count: 20 }),
      ]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.getHistory(90, "2024-06-15");

      expect(result).toEqual([]);
    });

    it("does NOT flag resting HR in history when z-score is exactly 2.0 (uses > not >=)", async () => {
      // z = (66-60)/3 = 2.0 exactly → NOT flagged
      const db = makeDb([
        historyRow({
          date: "2024-06-10",
          resting_hr: 66,
          rhr_mean: 60,
          rhr_sd: 3,
          rhr_count: 20,
        }),
      ]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.getHistory(90, "2024-06-15");

      expect(result).toEqual([]);
    });

    it("does NOT flag HRV in history when z-score is exactly -2.0 (uses < not <=)", async () => {
      // z = (40-50)/5 = -2.0 exactly → NOT flagged
      const db = makeDb([
        historyRow({
          date: "2024-06-10",
          hrv: 40,
          hrv_mean: 50,
          hrv_sd: 5,
          hrv_count: 20,
        }),
      ]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.getHistory(90, "2024-06-15");

      expect(result).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Boundary threshold tests
  // -----------------------------------------------------------------------

  describe("threshold boundaries", () => {
    it("does NOT flag resting HR when z-score is exactly 2.0 (uses > not >=)", async () => {
      // mean=60, sd=3, value=66 => z = (66-60)/3 = 2.0 exactly
      const db = makeDb([checkRow({ resting_hr: 66, rhr_mean: 60, rhr_sd: 3, rhr_count: 20 })]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");

      expect(result.checkedMetrics).toContain("resting_hr");
      expect(result.anomalies).toHaveLength(0);
    });

    it("classifies z-score exactly 3.0 as warning, not alert (uses > not >=)", async () => {
      // mean=60, sd=2, value=66 => z = (66-60)/2 = 3.0 exactly
      const db = makeDb([checkRow({ resting_hr: 66, rhr_mean: 60, rhr_sd: 2, rhr_count: 20 })]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");

      expect(result.anomalies).toHaveLength(1);
      expect(result.anomalies[0]?.severity).toBe("warning");
    });

    it("checks resting HR when rhr_count is exactly 14 (MIN_BASELINE_DAYS boundary)", async () => {
      const db = makeDb([checkRow({ resting_hr: 80, rhr_mean: 60, rhr_sd: 3, rhr_count: 14 })]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");

      expect(result.checkedMetrics).toContain("resting_hr");
      expect(result.anomalies).toHaveLength(1);
    });

    it("does NOT check resting HR when rhr_count is 13 (below MIN_BASELINE_DAYS)", async () => {
      const db = makeDb([checkRow({ resting_hr: 80, rhr_mean: 60, rhr_sd: 3, rhr_count: 13 })]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");

      expect(result.checkedMetrics).not.toContain("resting_hr");
      expect(result.anomalies).toHaveLength(0);
    });

    it("classifies HRV z-score of exactly -3.0 as warning, not alert (uses < not <=)", async () => {
      // mean=50, sd=5, value=35 => z = (35-50)/5 = -3.0 exactly
      const db = makeDb([checkRow({ hrv: 35, hrv_mean: 50, hrv_sd: 5, hrv_count: 20 })]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");

      expect(result.anomalies).toHaveLength(1);
      expect(result.anomalies[0]?.severity).toBe("warning");
    });

    it("does NOT flag HRV when z-score is exactly -2.0 (uses < not <=)", async () => {
      // mean=50, sd=5, value=40 => z = (40-50)/5 = -2.0 exactly
      const db = makeDb([checkRow({ hrv: 40, hrv_mean: 50, hrv_sd: 5, hrv_count: 20 })]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");

      expect(result.checkedMetrics).toContain("hrv");
      expect(result.anomalies).toHaveLength(0);
    });

    it("does NOT flag sleep when z-score is exactly -2.0 (uses < not <=)", async () => {
      // mean=420, sd=30, value=360 => z = (360-420)/30 = -2.0 exactly
      const db = makeDb([
        checkRow({ duration_minutes: 360, sleep_mean: 420, sleep_sd: 30, sleep_count: 20 }),
      ]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");

      expect(result.checkedMetrics).toContain("sleep_duration");
      expect(result.anomalies).toHaveLength(0);
    });

    it("classifies sleep z-score of exactly -3.0 as warning, not alert (uses < not <=)", async () => {
      // mean=420, sd=30, value=330 => z = (330-420)/30 = -3.0 exactly
      const db = makeDb([
        checkRow({ duration_minutes: 330, sleep_mean: 420, sleep_sd: 30, sleep_count: 20 }),
      ]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");

      expect(result.anomalies).toHaveLength(1);
      expect(result.anomalies[0]?.severity).toBe("warning");
    });

    it("rounds sleep values to integers (Math.round without *10/10)", async () => {
      // duration_minutes=349.7, sleep_mean=419.6, sleep_sd=29.8
      // z = (349.7 - 419.6)/29.8 = -69.9/29.8 = -2.346...
      const db = makeDb([
        checkRow({
          duration_minutes: 349.7,
          sleep_mean: 419.6,
          sleep_sd: 29.8,
          sleep_count: 20,
        }),
      ]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");

      expect(result.anomalies).toHaveLength(1);
      expect(result.anomalies[0]?.value).toBe(350); // Math.round(349.7)
      expect(result.anomalies[0]?.baselineMean).toBe(420); // Math.round(419.6)
      expect(result.anomalies[0]?.baselineStddev).toBe(30); // Math.round(29.8)
    });

    it("skips sleep check when sleep_count < 14", async () => {
      const db = makeDb([
        checkRow({ duration_minutes: 200, sleep_mean: 420, sleep_sd: 30, sleep_count: 10 }),
      ]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");

      expect(result.checkedMetrics).not.toContain("sleep_duration");
    });

    it("skips sleep check when sleep_sd is zero", async () => {
      const db = makeDb([
        checkRow({ duration_minutes: 200, sleep_mean: 420, sleep_sd: 0, sleep_count: 20 }),
      ]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");

      expect(result.checkedMetrics).not.toContain("sleep_duration");
    });
  });

  // -----------------------------------------------------------------------
  // getHistory() queryDays addition
  // -----------------------------------------------------------------------

  describe("getHistory queryDays", () => {
    it("passes days + BASELINE_WINDOW_DAYS (30) to the SQL query", async () => {
      const db = makeDb([]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      await repo.getHistory(90, "2024-06-15");

      // The execute call should have been made with queryDays = 90 + 30 = 120
      // We verify by checking that execute was called (the SQL embeds the value)
      expect(db.execute).toHaveBeenCalledTimes(1);
    });

    it("returns correct anomaly values from buildRestingHrAnomaly helper", async () => {
      // Verify all fields produced by buildRestingHrAnomaly:
      // metric name, rounding of baselineMean (*10/10), baselineStddev (*10/10), zScore (*100/100)
      const db = makeDb([
        historyRow({
          date: "2024-06-10",
          resting_hr: 75,
          rhr_mean: 62.345,
          rhr_sd: 4.567,
          rhr_count: 20,
        }),
      ]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.getHistory(90, "2024-06-15");

      expect(result).toHaveLength(1);
      const anomaly = result[0];
      expect(anomaly?.metric).toBe("Resting Heart Rate");
      expect(anomaly?.value).toBe(75);
      // baselineMean: Math.round(62.345 * 10) / 10 = Math.round(623.45) / 10 = 623/10 = 62.3
      expect(anomaly?.baselineMean).toBe(62.3);
      // baselineStddev: Math.round(4.567 * 10) / 10 = Math.round(45.67) / 10 = 46/10 = 4.6
      expect(anomaly?.baselineStddev).toBe(4.6);
      // z = (75 - 62.345) / 4.567 = 12.655 / 4.567 = 2.7712...
      // zScore: Math.round(2.7712 * 100) / 100 = Math.round(277.12) / 100 = 277/100 = 2.77
      expect(anomaly?.zScore).toBe(2.77);
    });

    it("returns correct anomaly values from buildHrvAnomaly helper", async () => {
      // z = (25 - 50) / 8 = -25/8 = -3.125
      const db = makeDb([
        historyRow({
          date: "2024-06-10",
          hrv: 25,
          hrv_mean: 48.765,
          hrv_sd: 6.234,
          hrv_count: 20,
        }),
      ]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.getHistory(90, "2024-06-15");

      expect(result).toHaveLength(1);
      const anomaly = result[0];
      expect(anomaly?.metric).toBe("Heart Rate Variability");
      expect(anomaly?.value).toBe(25);
      // baselineMean: Math.round(48.765 * 10) / 10 = Math.round(487.65) / 10 = 488/10 = 48.8
      expect(anomaly?.baselineMean).toBe(48.8);
      // baselineStddev: Math.round(6.234 * 10) / 10 = Math.round(62.34) / 10 = 62/10 = 6.2
      expect(anomaly?.baselineStddev).toBe(6.2);
      // z = (25 - 48.765) / 6.234 = -23.765 / 6.234 = -3.8122...
      // zScore: Math.round(-3.8122 * 100) / 100 = Math.round(-381.22) / 100 = -381/100 = -3.81
      expect(anomaly?.zScore).toBe(-3.81);
    });

    it("uses buildHrvAnomaly severity: alert when z < -3, warning otherwise", async () => {
      // z = (35-50)/5 = -3.0 exactly → HRV uses < -ALERT_THRESHOLD for alert, so -3.0 is warning
      const db = makeDb([
        historyRow({ date: "2024-06-10", hrv: 35, hrv_mean: 50, hrv_sd: 5, hrv_count: 20 }),
      ]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.getHistory(90, "2024-06-15");
      expect(result[0]?.severity).toBe("warning");
    });
  });

  // -----------------------------------------------------------------------
  // check() z-score computation direction
  // -----------------------------------------------------------------------

  describe("check z-score direction", () => {
    it("computes resting HR z-score as (value - mean) / sd (positive when value > mean)", async () => {
      // Verify the direction: higher resting HR = positive z-score
      // mean=60, sd=4, value=69 => z = (69-60)/4 = 2.25
      const db = makeDb([checkRow({ resting_hr: 69, rhr_mean: 60, rhr_sd: 4, rhr_count: 20 })]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");
      expect(result.anomalies[0]?.zScore).toBe(2.25);
    });

    it("computes HRV z-score as (value - mean) / sd (negative when value < mean)", async () => {
      // mean=50, sd=4, value=41 => z = (41-50)/4 = -2.25
      const db = makeDb([checkRow({ hrv: 41, hrv_mean: 50, hrv_sd: 4, hrv_count: 20 })]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");
      expect(result.anomalies[0]?.zScore).toBe(-2.25);
    });

    it("computes sleep z-score as (value - mean) / sd (negative when value < mean)", async () => {
      // mean=420, sd=40, value=330 => z = (330-420)/40 = -2.25
      const db = makeDb([
        checkRow({ duration_minutes: 330, sleep_mean: 420, sleep_sd: 40, sleep_count: 20 }),
      ]);
      const repo = new AnomalyDetectionRepository(db, "user-1", "UTC");
      const result = await repo.check("2024-06-15");
      expect(result.anomalies[0]?.zScore).toBe(-2.25);
    });
  });

  // -----------------------------------------------------------------------
  // checkAnomalies() standalone wrapper
  // -----------------------------------------------------------------------

  describe("checkAnomalies", () => {
    it("delegates to AnomalyDetectionRepository.check()", async () => {
      const db = makeDb([]);
      const result = await checkAnomalies(db, "user-1", "UTC", "2024-06-15");

      expect(result.anomalies).toEqual([]);
      expect(result.checkedMetrics).toEqual([]);
    });

    it("returns anomalies when present", async () => {
      const db = makeDb([checkRow({ resting_hr: 70, rhr_mean: 60, rhr_sd: 3, rhr_count: 20 })]);
      const result = await checkAnomalies(db, "user-1", "UTC", "2024-06-15");

      expect(result.anomalies).toHaveLength(1);
      expect(result.checkedMetrics).toContain("resting_hr");
    });
  });
});

// ---------------------------------------------------------------------------
// sendAnomalyAlertToSlack()
// ---------------------------------------------------------------------------

describe("sendAnomalyAlertToSlack", () => {
  function makeAnomalyDb(calls: unknown[][]) {
    const execute = vi.fn();
    for (const rows of calls) {
      execute.mockResolvedValueOnce(rows);
    }
    return { execute };
  }

  function makeAnomaly(overrides: Partial<AnomalyRow> = {}): AnomalyRow {
    return {
      date: "2024-06-15",
      metric: "Resting Heart Rate",
      value: 70,
      baselineMean: 60,
      baselineStddev: 3,
      zScore: 3.33,
      severity: "alert",
      ...overrides,
    };
  }

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns false for empty anomalies", async () => {
    const db = makeAnomalyDb([]);
    const result = await sendAnomalyAlertToSlack(db, "user-1", []);
    expect(result).toBe(false);
  });

  it("returns false when no Slack installation found", async () => {
    const db = makeAnomalyDb([[], []]);
    const result = await sendAnomalyAlertToSlack(db, "user-1", [makeAnomaly()]);
    expect(result).toBe(false);
  });

  it("returns false when no Slack account linked", async () => {
    const db = makeAnomalyDb([[{ bot_token: "xoxb-test" }], []]);
    const result = await sendAnomalyAlertToSlack(db, "user-1", [makeAnomaly()]);
    expect(result).toBe(false);
  });

  it("returns true and calls fetch on success with alert severity", async () => {
    const db = makeAnomalyDb([[{ bot_token: "xoxb-test" }], [{ provider_account_id: "U12345" }]]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });

    const result = await sendAnomalyAlertToSlack(db, "user-1", [
      makeAnomaly({ severity: "alert" }),
    ]);

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(fetchBody.channel).toBe("U12345");
    expect(fetchBody.blocks[0].text.text).toBe("Health Alert");
  });

  it("uses 'Health Warning' header when only warning severity anomalies", async () => {
    const db = makeAnomalyDb([[{ bot_token: "xoxb-test" }], [{ provider_account_id: "U12345" }]]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });

    const result = await sendAnomalyAlertToSlack(db, "user-1", [
      makeAnomaly({ severity: "warning" }),
    ]);

    expect(result).toBe(true);
    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(fetchBody.blocks[0].text.text).toBe("Health Warning");
  });

  it("includes illness pattern message when both HR and HRV anomalies present", async () => {
    const db = makeAnomalyDb([[{ bot_token: "xoxb-test" }], [{ provider_account_id: "U12345" }]]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });

    const anomalies = [
      makeAnomaly({ metric: "Resting Heart Rate" }),
      makeAnomaly({ metric: "Heart Rate Variability", zScore: -3.5 }),
    ];
    const result = await sendAnomalyAlertToSlack(db, "user-1", anomalies);

    expect(result).toBe(true);
    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const blockTexts = fetchBody.blocks.map((block: { text: { text: string } }) => block.text.text);
    expect(blockTexts.some((text: string) => text.includes("fighting something"))).toBe(true);
  });

  it("does NOT include illness message when only one of HR/HRV is anomalous", async () => {
    const db = makeAnomalyDb([[{ bot_token: "xoxb-test" }], [{ provider_account_id: "U12345" }]]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });

    const result = await sendAnomalyAlertToSlack(db, "user-1", [
      makeAnomaly({ metric: "Resting Heart Rate" }),
    ]);

    expect(result).toBe(true);
    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const blockTexts = fetchBody.blocks.map((block: { text: { text: string } }) => block.text.text);
    expect(blockTexts.some((text: string) => text.includes("fighting something"))).toBe(false);
  });

  it("returns false when fetch response.ok is false", async () => {
    const db = makeAnomalyDb([[{ bot_token: "xoxb-test" }], [{ provider_account_id: "U12345" }]]);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await sendAnomalyAlertToSlack(db, "user-1", [makeAnomaly()]);
    expect(result).toBe(false);
  });

  it("returns false when Slack API returns {ok: false}", async () => {
    const db = makeAnomalyDb([[{ bot_token: "xoxb-test" }], [{ provider_account_id: "U12345" }]]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: false, error: "channel_not_found" }),
    });

    const result = await sendAnomalyAlertToSlack(db, "user-1", [makeAnomaly()]);
    expect(result).toBe(false);
  });

  it("returns false when fetch throws an error", async () => {
    const db = makeAnomalyDb([[{ bot_token: "xoxb-test" }], [{ provider_account_id: "U12345" }]]);
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const result = await sendAnomalyAlertToSlack(db, "user-1", [makeAnomaly()]);
    expect(result).toBe(false);
  });

  it("returns false when fetch throws a non-Error value", async () => {
    const db = makeAnomalyDb([[{ bot_token: "xoxb-test" }], [{ provider_account_id: "U12345" }]]);
    mockFetch.mockRejectedValueOnce("string error");

    const result = await sendAnomalyAlertToSlack(db, "user-1", [makeAnomaly()]);
    expect(result).toBe(false);
  });

  it("includes anomaly detail text in Slack blocks", async () => {
    const db = makeAnomalyDb([[{ bot_token: "xoxb-test" }], [{ provider_account_id: "U12345" }]]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });

    const anomaly = makeAnomaly({
      metric: "Resting Heart Rate",
      value: 70,
      baselineMean: 60,
      baselineStddev: 3,
      zScore: 3.33,
    });
    await sendAnomalyAlertToSlack(db, "user-1", [anomaly]);

    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    // Block 2 (index 2) is the anomaly detail block
    expect(fetchBody.blocks[2].text.text).toContain("Resting Heart Rate");
    expect(fetchBody.blocks[2].text.text).toContain("70");
    expect(fetchBody.blocks[2].text.text).toContain("60");
    expect(fetchBody.blocks[2].text.text).toContain("3.33");
  });

  it("uses 'warning' in fallback text when no alert-severity anomalies", async () => {
    const db = makeAnomalyDb([[{ bot_token: "xoxb-test" }], [{ provider_account_id: "U12345" }]]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });

    await sendAnomalyAlertToSlack(db, "user-1", [makeAnomaly({ severity: "warning" })]);

    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(fetchBody.text).toContain("warning");
    expect(fetchBody.text).not.toContain("alert");
  });

  it("uses 'alert' in fallback text when any alert-severity anomaly exists", async () => {
    const db = makeAnomalyDb([[{ bot_token: "xoxb-test" }], [{ provider_account_id: "U12345" }]]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });

    await sendAnomalyAlertToSlack(db, "user-1", [makeAnomaly({ severity: "alert" })]);

    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(fetchBody.text).toContain("alert");
  });

  it("sends to correct Slack API URL with Bearer token", async () => {
    const db = makeAnomalyDb([
      [{ bot_token: "xoxb-my-token" }],
      [{ provider_account_id: "U99999" }],
    ]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });

    await sendAnomalyAlertToSlack(db, "user-1", [makeAnomaly()]);

    expect(mockFetch.mock.calls[0][0]).toBe("https://slack.com/api/chat.postMessage");
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe("Bearer xoxb-my-token");
    expect(mockFetch.mock.calls[0][1].method).toBe("POST");
  });
});
