import { describe, expect, it, vi } from "vitest";
import { buildStrainTargetResult, loadStrainTargetInputs } from "./strain-target-result.ts";

const equalWeights = {
  hrv: 0.25,
  restingHr: 0.25,
  sleep: 0.25,
  respiratoryRate: 0.25,
} as const;

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

describe("buildStrainTargetResult", () => {
  it("returns null when readiness metrics are missing", () => {
    expect(
      buildStrainTargetResult({
        endDate: "2026-07-26",
        readinessMetrics: undefined,
        loads: [{ date: "2026-07-26", daily_load: 40 }],
        readinessWeights: equalWeights,
      }),
    ).toBeNull();
  });

  it("builds a strain target from readiness and load windows", () => {
    const result = buildStrainTargetResult({
      endDate: "2026-07-26",
      readinessMetrics: {
        date: "2026-07-26",
        hrv_score: 80,
        resting_hr_score: 80,
        sleep_score: 80,
        respiratory_rate_score: 80,
      },
      loads: [
        { date: "2026-07-20", daily_load: 50 },
        { date: "2026-07-26", daily_load: 40 },
      ],
      readinessWeights: equalWeights,
    });

    expect(result).not.toBeNull();
    expect(result?.readinessScore).toBe(80);
    expect(result?.dailyLoad).toBe(40);
    expect(result?.currentStrain).toBeGreaterThan(0);
    expect(result?.targetStrain).toBeGreaterThan(0);
    expect(["Push", "Maintain", "Recovery"]).toContain(result?.zone);
    expect(result?.explanation.length).toBeGreaterThan(0);
  });

  it("excludes future daily loads from acute and chronic windows", () => {
    const withoutFuture = buildStrainTargetResult({
      endDate: "2026-07-26",
      readinessMetrics: {
        date: "2026-07-26",
        hrv_score: 80,
        resting_hr_score: 80,
        sleep_score: 80,
        respiratory_rate_score: 80,
      },
      loads: [
        { date: "2026-07-20", daily_load: 50 },
        { date: "2026-07-26", daily_load: 40 },
      ],
      readinessWeights: equalWeights,
    });

    const withFuture = buildStrainTargetResult({
      endDate: "2026-07-26",
      readinessMetrics: {
        date: "2026-07-26",
        hrv_score: 80,
        resting_hr_score: 80,
        sleep_score: 80,
        respiratory_rate_score: 80,
      },
      loads: [
        { date: "2026-07-20", daily_load: 50 },
        { date: "2026-07-26", daily_load: 40 },
        { date: "2026-07-27", daily_load: 500 },
      ],
      readinessWeights: equalWeights,
    });

    expect(withFuture?.acuteLoad).toBe(withoutFuture?.acuteLoad);
    expect(withFuture?.chronicLoad).toBe(withoutFuture?.chronicLoad);
    expect(withFuture?.workloadRatio).toBe(withoutFuture?.workloadRatio);
    expect(withFuture?.dailyLoad).toBe(40);
  });
});

describe("loadStrainTargetInputs", () => {
  it("loads readiness and strain rows with shared access-window clauses", async () => {
    const query = vi.fn(
      async (_schema: unknown, queryText: unknown, params: unknown, options: unknown) => {
        const sqlText = String(queryText);
        expect(options).toEqual({ priority: "dashboard" });
        expect(params).toMatchObject({
          userId: "00000000-0000-4000-8000-000000000001",
          endDate: "2026-07-26",
          accessStartDate: "2026-07-01",
          accessEndDateExclusive: "2026-07-08",
        });

        if (sqlText.includes("analytics.daily_recovery")) {
          expect(sqlText).toContain("AND recovery.date >= toDate({accessStartDate:String})");
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
          expect(sqlText).toContain("AND strain.date >= toDate({accessStartDate:String})");
          return [{ date: "2026-07-26", daily_load: 40 }];
        }

        return [];
      },
    );

    const inputs = await loadStrainTargetInputs({
      sensorStore: makeSensorStore(query),
      userId: "00000000-0000-4000-8000-000000000001",
      endDate: "2026-07-26",
      accessWindow: {
        kind: "limited",
        paid: false,
        reason: "free_signup_week",
        startDate: "2026-07-01",
        endDateExclusive: "2026-07-08",
      },
    });

    expect(inputs.readinessMetrics?.date).toBe("2026-07-26");
    expect(inputs.loads).toEqual([{ date: "2026-07-26", daily_load: 40 }]);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
