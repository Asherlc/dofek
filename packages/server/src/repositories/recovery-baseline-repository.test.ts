import { describe, expect, it, vi } from "vitest";
import { RecoveryBaselineRepository } from "./recovery-baseline-repository.ts";

const rawRow = {
  date: "2026-07-29",
  hrv: 72,
  resting_hr: 48,
  respiratory_rate: 14,
  efficiency_pct: 90,
  hrv_mean_30d: 60,
  hrv_sd_30d: 6,
  hrv_z_score: 2,
  hrv_baseline_sample_count: 24,
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

describe("RecoveryBaselineRepository", () => {
  it("maps one compact daily recovery row into all recovery baseline metrics", async () => {
    const sensorStore = { query: vi.fn().mockResolvedValue([rawRow]) };
    const repository = new RecoveryBaselineRepository(
      "00000000-0000-4000-8000-000000000001",
      sensorStore,
    );

    const result = await repository.listRange("2026-07-01", "2026-07-29");

    expect(result).toHaveLength(1);
    expect(result[0]?.date).toBe("2026-07-29");
    expect(result[0]?.metrics.map((metric) => metric.metric)).toEqual([
      "hrv",
      "resting_heart_rate",
      "respiratory_rate",
      "sleep_efficiency",
    ]);
    expect(result[0]?.metrics[0]).toMatchObject({
      value: 72,
      baseline: { mean: 60, zScore: 2, sampleCount: 24, coverage: 0.8 },
      comparison: { delta: 5, direction: "increasing" },
    });
    expect(result[0]?.metrics[1]).toMatchObject({
      value: 48,
      baseline: { mean: 52, zScore: -2 },
      comparison: { delta: -4, direction: "decreasing" },
    });
  });

  it("reads the canonical serving model for the exact inclusive range", async () => {
    const sensorStore = { query: vi.fn().mockResolvedValue([]) };
    const repository = new RecoveryBaselineRepository(
      "00000000-0000-4000-8000-000000000001",
      sensorStore,
    );

    await repository.listRange("2026-07-01", "2026-07-29");

    expect(sensorStore.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("FROM analytics.daily_recovery AS recovery FINAL"),
      {
        userId: "00000000-0000-4000-8000-000000000001",
        startDate: "2026-07-01",
        endDate: "2026-07-29",
      },
      undefined,
    );
    const query = sensorStore.query.mock.calls[0]?.[1];
    expect(query).toContain("recovery.is_deleted = 0");
    expect(query).toContain("recovery.date >= toDate({startDate:String})");
    expect(query).toContain("recovery.date <= toDate({endDate:String})");
  });

  it("constrains recovery rows to a limited access window", async () => {
    const sensorStore = { query: vi.fn().mockResolvedValue([]) };
    const repository = new RecoveryBaselineRepository(
      "00000000-0000-4000-8000-000000000001",
      sensorStore,
      {
        kind: "limited",
        paid: false,
        reason: "free_signup_week",
        startDate: "2026-07-10",
        endDateExclusive: "2026-07-17",
      },
    );

    await repository.listRange("2026-07-01", "2026-07-29");

    const query = sensorStore.query.mock.calls[0]?.[1];
    expect(query).toContain("recovery.date >= toDate({accessStartDate:String})");
    expect(query).toContain("recovery.date < toDate({accessEndDateExclusive:String})");
    expect(sensorStore.query.mock.calls[0]?.[2]).toMatchObject({
      accessStartDate: "2026-07-10",
      accessEndDateExclusive: "2026-07-17",
    });
  });

  it("fetches only the latest non-null row dates for canonical recovery metrics", async () => {
    const sensorStore = { query: vi.fn().mockResolvedValue([rawRow]) };
    const repository = new RecoveryBaselineRepository(
      "00000000-0000-4000-8000-000000000001",
      sensorStore,
    );

    const result = await repository.latestMetrics("2026-07-29");

    expect(result.map((metric) => metric.metric)).toEqual([
      "hrv",
      "resting_heart_rate",
      "respiratory_rate",
      "sleep_efficiency",
    ]);
    const query = sensorStore.query.mock.calls[0]?.[1];
    expect(query).toContain("maxIf(latest.date, latest.hrv IS NOT NULL)");
    expect(query).toContain("maxIf(latest.date, latest.efficiency_pct IS NOT NULL)");
    expect(query).toContain("recovery.date IN");
    expect(query).not.toContain("startDate");
    expect(sensorStore.query.mock.calls[0]?.[2]).toEqual({
      userId: "00000000-0000-4000-8000-000000000001",
      endDate: "2026-07-29",
    });
  });
});
