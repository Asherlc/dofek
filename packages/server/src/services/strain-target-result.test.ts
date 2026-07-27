import { describe, expect, it } from "vitest";
import { buildStrainTargetResult } from "./strain-target-result.ts";

const equalWeights = {
  hrv: 0.25,
  restingHr: 0.25,
  sleep: 0.25,
  respiratoryRate: 0.25,
} as const;

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
