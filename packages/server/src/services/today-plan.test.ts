import { describe, expect, it, vi } from "vitest";

vi.mock("dofek/personalization/storage", () => ({
  loadPersonalizedParams: vi.fn(async () => null),
}));

import { loadTodayPlan } from "./today-plan.ts";

type SensorStore = import("../repositories/activity-repository.ts").ActivitySensorStore;

function makeSensorStore(queryImpl: SensorStore["query"]): SensorStore {
  return {
    query: queryImpl,
    getActivitySummaries: vi.fn().mockResolvedValue([]),
    getStream: vi.fn().mockResolvedValue([]),
    getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerCurveSamples: vi.fn().mockResolvedValue([]),
    getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
    getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
    getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
    getPaceCurveRows: vi.fn().mockResolvedValue([]),
  };
}

describe("loadTodayPlan", () => {
  it("returns insufficient_data when recovery rows are missing", async () => {
    const query = vi.fn(async (_schema: unknown, queryText: unknown) => {
      const sqlText = String(queryText);
      if (sqlText.includes("analytics.daily_recovery")) return [];
      if (sqlText.includes("analytics.daily_strain")) return [];
      if (sqlText.includes("analytics.daily_sleep")) return [];
      return [];
    });

    const plan = await loadTodayPlan(
      {
        db: { execute: vi.fn() },
        userId: "00000000-0000-4000-8000-000000000001",
        sensorStore: makeSensorStore(query),
      },
      "2026-07-26",
    );

    expect(plan.status).toBe("insufficient_data");
    expect(plan.missingInputs).toEqual(["recovery"]);
    expect(plan.message).toContain("recovery");
  });

  it("returns a ready plan with recovery and sleep supporting facts", async () => {
    const query = vi.fn(async (_schema: unknown, queryText: unknown) => {
      const sqlText = String(queryText);
      if (sqlText.includes("analytics.daily_recovery")) {
        return [
          {
            date: "2026-07-26",
            hrv_score: 80,
            resting_hr_score: 80,
            sleep_score: 80,
            respiratory_rate_score: 80,
          },
        ];
      }
      if (sqlText.includes("analytics.daily_strain")) {
        return [{ date: "2026-07-26", daily_load: 40 }];
      }
      if (sqlText.includes("analytics.daily_sleep")) {
        return [{ date: "2026-07-26", duration_minutes: 480, efficiency_pct: 90 }];
      }
      return [];
    });

    const plan = await loadTodayPlan(
      {
        db: { execute: vi.fn() },
        userId: "00000000-0000-4000-8000-000000000001",
        sensorStore: makeSensorStore(query),
      },
      "2026-07-26",
    );

    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    expect(plan.action.id).toBe("strain_target");
    expect(plan.action.title).toContain("strain");
    expect(plan.supportingFacts).toHaveLength(2);
    expect(plan.supportingFacts[0]?.label).toBe("Recovery");
    expect(plan.supportingFacts[1]?.label).toBe("Sleep performance");
    expect(plan.confidence).toBe("high");
    expect(plan.freshness.recoveryDate).toBe("2026-07-26");
    expect(plan.freshness.sleepDate).toBe("2026-07-26");
  });

  it("queries the recovery, strain, and sleep read models", async () => {
    const query = vi.fn(async () => []);
    await loadTodayPlan(
      {
        db: { execute: vi.fn() },
        userId: "00000000-0000-4000-8000-000000000001",
        sensorStore: makeSensorStore(query),
      },
      "2026-07-26",
    );

    const queryTexts = query.mock.calls.map((call) => String(call[1]));
    expect(queryTexts.some((text) => text.includes("analytics.daily_recovery"))).toBe(true);
    expect(queryTexts.some((text) => text.includes("analytics.daily_strain"))).toBe(true);
    expect(queryTexts.some((text) => text.includes("analytics.daily_sleep"))).toBe(true);
  });
});
