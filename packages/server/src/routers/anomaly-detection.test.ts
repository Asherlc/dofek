import { describe, expect, it, vi } from "vitest";

const mockExecuteWithSchema = vi.fn();

vi.mock("../lib/typed-sql.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/typed-sql.ts")>();
  return {
    ...original,
    executeWithSchema: (...args: unknown[]) => mockExecuteWithSchema(...args),
  };
});

vi.mock("../logger.ts", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { checkAnomalies } from "./anomaly-detection.ts";

function makeDb(rows: Record<string, unknown>[]) {
  mockExecuteWithSchema.mockReset();
  mockExecuteWithSchema.mockResolvedValue(rows);
  return { execute: vi.fn().mockResolvedValue(rows) };
}

function makeSensorStore(sleepRows: Record<string, unknown>[] = []) {
  const sleepRowsWithLocalTimeContext = sleepRows.map((row) => ({
    timezone: null,
    start_utc_offset_minutes: null,
    end_utc_offset_minutes: null,
    local_time_source: "unknown",
    ...row,
  }));
  return {
    query: vi.fn(async (_schema: unknown, query: string) =>
      query.includes("analytics.daily_sleep") || query.includes("analytics.v_sleep")
        ? sleepRowsWithLocalTimeContext
        : [{ date: "2024-01-14", resting_hr: 52 }],
    ),
  };
}

function dateDaysBefore(dateString: string, daysBefore: number): string {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - daysBefore);
  return date.toISOString().slice(0, 10);
}

function sleepRowsForBaseline({
  targetDate,
  targetDuration,
  baselineMean,
  baselineStddev,
  baselineCount = 20,
}: {
  targetDate: string;
  targetDuration: number | null;
  baselineMean: number;
  baselineStddev: number;
  baselineCount?: number;
}) {
  const baselineRows = Array.from({ length: baselineCount }, (_unused, index) => ({
    date: dateDaysBefore(targetDate, baselineCount - index),
    provider_id: "whoop",
    source_name: null,
    source_providers: ["whoop"],
    started_at: `${dateDaysBefore(targetDate, baselineCount - index)}T23:00:00Z`,
    ended_at: `${dateDaysBefore(targetDate, baselineCount - index - 1)}T07:00:00Z`,
    duration_minutes:
      index % 2 === 0 ? baselineMean - baselineStddev : baselineMean + baselineStddev,
    deep_minutes: null,
    rem_minutes: null,
    light_minutes: null,
    awake_minutes: null,
    efficiency_pct: null,
    staging_available: false,
  }));
  return [
    ...baselineRows,
    {
      date: targetDate,
      provider_id: "whoop",
      source_name: null,
      source_providers: ["whoop"],
      started_at: `${targetDate}T23:00:00Z`,
      ended_at: `${dateDaysBefore(targetDate, -1)}T07:00:00Z`,
      duration_minutes: targetDuration,
      deep_minutes: null,
      rem_minutes: null,
      light_minutes: null,
      awake_minutes: null,
      efficiency_pct: null,
      staging_available: false,
    },
  ];
}

describe("checkAnomalies", () => {
  it("returns empty when no data", async () => {
    const db = makeDb([]);
    const result = await checkAnomalies(db, "user-1", "UTC", "2024-01-15", makeSensorStore());
    expect(result.anomalies).toEqual([]);
    expect(result.checkedMetrics).toEqual([]);
  });

  it("returns empty when row has null date", async () => {
    const db = makeDb([{ date: null }]);
    const result = await checkAnomalies(db, "user-1", "UTC", "2024-01-15", makeSensorStore());
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
    const result = await checkAnomalies(db, "user-1", "UTC", "2024-01-15", makeSensorStore());

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
    const result = await checkAnomalies(db, "user-1", "UTC", "2024-01-15", makeSensorStore());

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
    const result = await checkAnomalies(db, "user-1", "UTC", "2024-01-15", makeSensorStore());
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
    const result = await checkAnomalies(db, "user-1", "UTC", "2024-01-15", makeSensorStore());

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
    const result = await checkAnomalies(
      db,
      "user-1",
      "UTC",
      "2024-01-15",
      makeSensorStore(
        sleepRowsForBaseline({
          targetDate: "2024-01-15",
          targetDuration: 300,
          baselineMean: 480,
          baselineStddev: 60,
        }),
      ),
    );

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
    const result = await checkAnomalies(
      db,
      "user-1",
      "UTC",
      "2024-01-15",
      makeSensorStore(
        sleepRowsForBaseline({
          targetDate: "2024-01-15",
          targetDuration: 460,
          baselineMean: 480,
          baselineStddev: 60,
        }),
      ),
    );

    expect(result.checkedMetrics).toHaveLength(3);
    expect(result.anomalies).toHaveLength(0);
  });

  it("classifies resting HR alert (z > 3)", async () => {
    const db = makeDb([
      {
        date: "2024-01-15",
        resting_hr: 76,
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
    const result = await checkAnomalies(db, "user-1", "UTC", "2024-01-15", makeSensorStore());

    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]?.severity).toBe("alert"); // z = 3.2 > 3
    expect(result.anomalies[0]?.zScore).toBe(3.2);
  });

  it("classifies HRV alert (z < -3)", async () => {
    const db = makeDb([
      {
        date: "2024-01-15",
        resting_hr: null,
        rhr_mean: null,
        rhr_sd: null,
        rhr_count: null,
        hrv: 15,
        hrv_mean: 50,
        hrv_sd: 10,
        hrv_count: 20,
        duration_minutes: null,
        sleep_mean: null,
        sleep_sd: null,
        sleep_count: null,
      },
    ]);
    const result = await checkAnomalies(db, "user-1", "UTC", "2024-01-15", makeSensorStore());

    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]?.severity).toBe("alert"); // z = -3.5 < -3
    expect(result.anomalies[0]?.zScore).toBe(-3.5);
  });

  it("classifies sleep alert (z < -3)", async () => {
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
        duration_minutes: 240,
        sleep_mean: 480,
        sleep_sd: 60,
        sleep_count: 20,
      },
    ]);
    const result = await checkAnomalies(
      db,
      "user-1",
      "UTC",
      "2024-01-15",
      makeSensorStore(
        sleepRowsForBaseline({
          targetDate: "2024-01-15",
          targetDuration: 240,
          baselineMean: 480,
          baselineStddev: 60,
        }),
      ),
    );

    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]?.severity).toBe("alert"); // z = -4.0 < -3
    expect(result.anomalies[0]?.zScore).toBe(-4);
  });

  it("detects all three anomalies simultaneously", async () => {
    const db = makeDb([
      {
        date: "2024-01-15",
        resting_hr: 80,
        rhr_mean: 60,
        rhr_sd: 5,
        rhr_count: 20,
        hrv: 15,
        hrv_mean: 50,
        hrv_sd: 10,
        hrv_count: 20,
        duration_minutes: 240,
        sleep_mean: 480,
        sleep_sd: 60,
        sleep_count: 20,
      },
    ]);
    const result = await checkAnomalies(
      db,
      "user-1",
      "UTC",
      "2024-01-15",
      makeSensorStore(
        sleepRowsForBaseline({
          targetDate: "2024-01-15",
          targetDuration: 240,
          baselineMean: 480,
          baselineStddev: 60,
        }),
      ),
    );

    expect(result.checkedMetrics).toHaveLength(3);
    expect(result.checkedMetrics).toContain("resting_hr");
    expect(result.checkedMetrics).toContain("hrv");
    expect(result.checkedMetrics).toContain("sleep_duration");
    expect(result.anomalies).toHaveLength(3);
  });

  it("computes baselineMean and baselineStddev with correct rounding", async () => {
    const db = makeDb([
      {
        date: "2024-01-15",
        resting_hr: 75,
        rhr_mean: 60.45,
        rhr_sd: 5.67,
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
    const result = await checkAnomalies(db, "user-1", "UTC", "2024-01-15", makeSensorStore());
    expect(result.anomalies[0]?.baselineMean).toBe(60.5);
    expect(result.anomalies[0]?.baselineStddev).toBe(5.7);
    expect(result.anomalies[0]?.value).toBe(75);
  });

  it("does not flag resting HR at exactly z=2 (requires > 2)", async () => {
    const db = makeDb([
      {
        date: "2024-01-15",
        resting_hr: 70,
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
    const result = await checkAnomalies(db, "user-1", "UTC", "2024-01-15", makeSensorStore());
    // z = (70-60)/5 = 2.0 — not > 2
    expect(result.checkedMetrics).toContain("resting_hr");
    expect(result.anomalies).toHaveLength(0);
  });

  it("does not flag HRV at exactly z=-2 (requires < -2)", async () => {
    const db = makeDb([
      {
        date: "2024-01-15",
        resting_hr: null,
        rhr_mean: null,
        rhr_sd: null,
        rhr_count: null,
        hrv: 30,
        hrv_mean: 50,
        hrv_sd: 10,
        hrv_count: 20,
        duration_minutes: null,
        sleep_mean: null,
        sleep_sd: null,
        sleep_count: null,
      },
    ]);
    const result = await checkAnomalies(db, "user-1", "UTC", "2024-01-15", makeSensorStore());
    // z = (30-50)/10 = -2.0 — not < -2
    expect(result.checkedMetrics).toContain("hrv");
    expect(result.anomalies).toHaveLength(0);
  });

  it("skips HRV check with insufficient data (count < 14)", async () => {
    const db = makeDb([
      {
        date: "2024-01-15",
        resting_hr: null,
        rhr_mean: null,
        rhr_sd: null,
        rhr_count: null,
        hrv: 10,
        hrv_mean: 50,
        hrv_sd: 10,
        hrv_count: 10,
        duration_minutes: null,
        sleep_mean: null,
        sleep_sd: null,
        sleep_count: null,
      },
    ]);
    const result = await checkAnomalies(
      db,
      "user-1",
      "UTC",
      "2024-01-15",
      makeSensorStore(
        sleepRowsForBaseline({
          targetDate: "2024-01-15",
          targetDuration: 280.7,
          baselineMean: 480.3,
          baselineStddev: 60.9,
        }),
      ),
    );
    expect(result.checkedMetrics).not.toContain("hrv");
  });

  it("skips sleep check with insufficient data (count < 14)", async () => {
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
        duration_minutes: 100,
        sleep_mean: 480,
        sleep_sd: 60,
        sleep_count: 10,
      },
    ]);
    const result = await checkAnomalies(db, "user-1", "UTC", "2024-01-15", makeSensorStore());
    expect(result.checkedMetrics).not.toContain("sleep_duration");
  });

  it("rounds sleep values to integers", async () => {
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
        duration_minutes: 280.7,
        sleep_mean: 480.3,
        sleep_sd: 60.9,
        sleep_count: 20,
      },
    ]);
    const result = await checkAnomalies(
      db,
      "user-1",
      "UTC",
      "2024-01-15",
      makeSensorStore(
        sleepRowsForBaseline({
          targetDate: "2024-01-15",
          targetDuration: 280.7,
          baselineMean: 480.3,
          baselineStddev: 60.9,
        }),
      ),
    );
    expect(result.anomalies[0]?.value).toBe(281);
    expect(result.anomalies[0]?.baselineMean).toBe(480);
    expect(result.anomalies[0]?.baselineStddev).toBe(61);
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
    const result = await checkAnomalies(db, "user-1", "UTC", "2024-01-15", makeSensorStore());
    expect(result.checkedMetrics).not.toContain("resting_hr");
  });
});
