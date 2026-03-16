import { describe, expect, it, vi } from "vitest";

const mockExecuteWithSchema = vi.fn();

vi.mock("../lib/typed-sql.ts", () => ({
  executeWithSchema: (...args: unknown[]) => mockExecuteWithSchema(...args),
}));

vi.mock("../logger.ts", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { checkAnomalies, sendAnomalyAlertToSlack } from "./anomaly-detection.ts";

function makeDb(rows: Record<string, unknown>[]) {
  mockExecuteWithSchema.mockReset();
  mockExecuteWithSchema.mockResolvedValue(rows);
  return { execute: vi.fn().mockResolvedValue(rows) };
}

describe("checkAnomalies", () => {
  it("returns empty when no data", async () => {
    const db = makeDb([]);
    const result = await checkAnomalies(db, "user-1");
    expect(result.anomalies).toEqual([]);
    expect(result.checkedMetrics).toEqual([]);
  });

  it("returns empty when row has null date", async () => {
    const db = makeDb([{ date: null }]);
    const result = await checkAnomalies(db, "user-1");
    expect(result.anomalies).toEqual([]);
  });

  it("detects elevated resting HR anomaly (z > 2)", async () => {
    const db = makeDb([
      {
        date: "2024-01-15",
        resting_hr: 75,
        rhr_mean: 60,
        rhr_sd: 5,
        rhr_count: 20,
        hrv: null,
        hrv_mean: null,
        hrv_sd: null,
        hrv_count: null,
        duration_minutes: null,
        sleep_mean: null,
        sleep_sd: null,
        sleep_count: null,
      },
    ]);
    const result = await checkAnomalies(db, "user-1");

    expect(result.checkedMetrics).toContain("resting_hr");
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]?.metric).toBe("Resting Heart Rate");
    expect(result.anomalies[0]?.severity).toBe("warning"); // z = 3.0 is not > 3
  });

  it("classifies resting HR warning (2 < z <= 3)", async () => {
    const db = makeDb([
      {
        date: "2024-01-15",
        resting_hr: 71,
        rhr_mean: 60,
        rhr_sd: 5,
        rhr_count: 20,
        hrv: null,
        hrv_mean: null,
        hrv_sd: null,
        hrv_count: null,
        duration_minutes: null,
        sleep_mean: null,
        sleep_sd: null,
        sleep_count: null,
      },
    ]);
    const result = await checkAnomalies(db, "user-1");

    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]?.severity).toBe("warning");
  });

  it("skips resting HR check with insufficient data (count < 14)", async () => {
    const db = makeDb([
      {
        date: "2024-01-15",
        resting_hr: 100,
        rhr_mean: 60,
        rhr_sd: 5,
        rhr_count: 10,
        hrv: null,
        hrv_mean: null,
        hrv_sd: null,
        hrv_count: null,
        duration_minutes: null,
        sleep_mean: null,
        sleep_sd: null,
        sleep_count: null,
      },
    ]);
    const result = await checkAnomalies(db, "user-1");
    expect(result.checkedMetrics).not.toContain("resting_hr");
  });

  it("detects depressed HRV anomaly (z < -2)", async () => {
    const db = makeDb([
      {
        date: "2024-01-15",
        resting_hr: null,
        rhr_mean: null,
        rhr_sd: null,
        rhr_count: null,
        hrv: 20,
        hrv_mean: 50,
        hrv_sd: 10,
        hrv_count: 20,
        duration_minutes: null,
        sleep_mean: null,
        sleep_sd: null,
        sleep_count: null,
      },
    ]);
    const result = await checkAnomalies(db, "user-1");

    expect(result.checkedMetrics).toContain("hrv");
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]?.metric).toBe("Heart Rate Variability");
    expect(result.anomalies[0]?.severity).toBe("warning"); // z = -3.0 is not < -3
  });

  it("detects short sleep anomaly (z < -2)", async () => {
    const db = makeDb([
      {
        date: "2024-01-15",
        resting_hr: null,
        rhr_mean: null,
        rhr_sd: null,
        rhr_count: null,
        hrv: null,
        hrv_mean: null,
        hrv_sd: null,
        hrv_count: null,
        duration_minutes: 300,
        sleep_mean: 480,
        sleep_sd: 60,
        sleep_count: 20,
      },
    ]);
    const result = await checkAnomalies(db, "user-1");

    expect(result.checkedMetrics).toContain("sleep_duration");
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]?.metric).toBe("Sleep Duration");
    expect(result.anomalies[0]?.severity).toBe("warning"); // z = -3.0 is not < -3
  });

  it("does not flag normal values", async () => {
    const db = makeDb([
      {
        date: "2024-01-15",
        resting_hr: 62,
        rhr_mean: 60,
        rhr_sd: 5,
        rhr_count: 20,
        hrv: 48,
        hrv_mean: 50,
        hrv_sd: 10,
        hrv_count: 20,
        duration_minutes: 460,
        sleep_mean: 480,
        sleep_sd: 60,
        sleep_count: 20,
      },
    ]);
    const result = await checkAnomalies(db, "user-1");

    expect(result.checkedMetrics).toHaveLength(3);
    expect(result.anomalies).toHaveLength(0);
  });

  it("skips checks when stddev is 0", async () => {
    const db = makeDb([
      {
        date: "2024-01-15",
        resting_hr: 75,
        rhr_mean: 60,
        rhr_sd: 0,
        rhr_count: 20,
        hrv: null,
        hrv_mean: null,
        hrv_sd: null,
        hrv_count: null,
        duration_minutes: null,
        sleep_mean: null,
        sleep_sd: null,
        sleep_count: null,
      },
    ]);
    const result = await checkAnomalies(db, "user-1");
    expect(result.checkedMetrics).not.toContain("resting_hr");
  });
});

describe("sendAnomalyAlertToSlack", () => {
  it("returns false when no anomalies", async () => {
    const db = makeDb([]);
    const result = await sendAnomalyAlertToSlack(db, "user-1", []);
    expect(result).toBe(false);
  });

  it("returns false when no Slack installation", async () => {
    mockExecuteWithSchema.mockReset();
    mockExecuteWithSchema.mockResolvedValue([]);
    const db = {};
    const anomalies = [
      {
        date: "2024-01-15",
        metric: "Resting Heart Rate",
        value: 75,
        baselineMean: 60,
        baselineStddev: 5,
        zScore: 3.0,
        severity: "alert" as const,
      },
    ];
    const result = await sendAnomalyAlertToSlack(db, "user-1", anomalies);
    expect(result).toBe(false);
  });

  it("returns false when no Slack account linked", async () => {
    mockExecuteWithSchema.mockReset();
    mockExecuteWithSchema.mockResolvedValueOnce([{ bot_token: "xoxb-fake" }]);
    mockExecuteWithSchema.mockResolvedValueOnce([]);
    const db = {};

    const anomalies = [
      {
        date: "2024-01-15",
        metric: "Resting Heart Rate",
        value: 75,
        baselineMean: 60,
        baselineStddev: 5,
        zScore: 3.0,
        severity: "alert" as const,
      },
    ];
    const result = await sendAnomalyAlertToSlack(db, "user-1", anomalies);
    expect(result).toBe(false);
  });

  it("sends Slack message and returns true on success", async () => {
    mockExecuteWithSchema.mockReset();
    mockExecuteWithSchema.mockResolvedValueOnce([{ bot_token: "xoxb-fake" }]);
    mockExecuteWithSchema.mockResolvedValueOnce([{ provider_account_id: "U12345" }]);
    const db = {};

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });

    const anomalies = [
      {
        date: "2024-01-15",
        metric: "Resting Heart Rate",
        value: 75,
        baselineMean: 60,
        baselineStddev: 5,
        zScore: 3.0,
        severity: "alert" as const,
      },
    ];
    const result = await sendAnomalyAlertToSlack(db, "user-1", anomalies);
    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    fetchSpy.mockRestore();
  });

  it("includes illness warning when both HR and HRV are anomalous", async () => {
    mockExecuteWithSchema.mockReset();
    mockExecuteWithSchema.mockResolvedValueOnce([{ bot_token: "xoxb-fake" }]);
    mockExecuteWithSchema.mockResolvedValueOnce([{ provider_account_id: "U12345" }]);
    const db = {};

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });

    const anomalies = [
      {
        date: "2024-01-15",
        metric: "Resting Heart Rate",
        value: 75,
        baselineMean: 60,
        baselineStddev: 5,
        zScore: 3.0,
        severity: "alert" as const,
      },
      {
        date: "2024-01-15",
        metric: "Heart Rate Variability",
        value: 20,
        baselineMean: 50,
        baselineStddev: 10,
        zScore: -3.0,
        severity: "alert" as const,
      },
    ];
    const result = await sendAnomalyAlertToSlack(db, "user-1", anomalies);
    expect(result).toBe(true);

    // Check the body of the fetch call includes the illness pattern message
    const callBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    const blockTexts = callBody.blocks.map((b: { text?: { text: string } }) => b.text?.text);
    expect(blockTexts.some((t: string) => t?.includes("fighting something"))).toBe(true);
    fetchSpy.mockRestore();
  });

  it("returns false when Slack API returns non-ok HTTP", async () => {
    mockExecuteWithSchema.mockReset();
    mockExecuteWithSchema.mockResolvedValueOnce([{ bot_token: "xoxb-fake" }]);
    mockExecuteWithSchema.mockResolvedValueOnce([{ provider_account_id: "U12345" }]);
    const db = {};

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
    });

    const anomalies = [
      {
        date: "2024-01-15",
        metric: "Resting Heart Rate",
        value: 75,
        baselineMean: 60,
        baselineStddev: 5,
        zScore: 3.0,
        severity: "alert" as const,
      },
    ];
    const result = await sendAnomalyAlertToSlack(db, "user-1", anomalies);
    expect(result).toBe(false);
    fetchSpy.mockRestore();
  });

  it("returns false when Slack API returns ok:false", async () => {
    mockExecuteWithSchema.mockReset();
    mockExecuteWithSchema.mockResolvedValueOnce([{ bot_token: "xoxb-fake" }]);
    mockExecuteWithSchema.mockResolvedValueOnce([{ provider_account_id: "U12345" }]);
    const db = {};

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: false, error: "channel_not_found" }),
    });

    const anomalies = [
      {
        date: "2024-01-15",
        metric: "Resting Heart Rate",
        value: 75,
        baselineMean: 60,
        baselineStddev: 5,
        zScore: 3.0,
        severity: "alert" as const,
      },
    ];
    const result = await sendAnomalyAlertToSlack(db, "user-1", anomalies);
    expect(result).toBe(false);
    fetchSpy.mockRestore();
  });

  it("returns false when fetch throws", async () => {
    mockExecuteWithSchema.mockReset();
    mockExecuteWithSchema.mockResolvedValueOnce([{ bot_token: "xoxb-fake" }]);
    mockExecuteWithSchema.mockResolvedValueOnce([{ provider_account_id: "U12345" }]);
    const db = {};

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network error"));

    const anomalies = [
      {
        date: "2024-01-15",
        metric: "Resting Heart Rate",
        value: 75,
        baselineMean: 60,
        baselineStddev: 5,
        zScore: 3.0,
        severity: "alert" as const,
      },
    ];
    const result = await sendAnomalyAlertToSlack(db, "user-1", anomalies);
    expect(result).toBe(false);
    fetchSpy.mockRestore();
  });
});
