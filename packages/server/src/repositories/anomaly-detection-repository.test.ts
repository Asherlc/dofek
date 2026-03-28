import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnomalyDetectionRepository,
  type AnomalyRow,
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
});
