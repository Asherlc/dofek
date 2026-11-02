import { describe, expect, it } from "vitest";
import {
  type PmcActivityRow,
  type PmcTrainingLoadAlgorithms,
  PmcTrainingLoadCalculator,
} from "./pmc-training-load-calculator.ts";

function makeActivityRow(overrides: Partial<PmcActivityRow> = {}): PmcActivityRow {
  return {
    global_max_hr: 190,
    resting_hr: 60,
    id: "activity-1",
    date: "2026-05-20",
    duration_min: 60,
    avg_hr: 150,
    max_hr: 180,
    avg_power: 200,
    power_samples: 3600,
    hr_samples: 3600,
    ...overrides,
  };
}

function makeAlgorithms(
  overrides: Partial<PmcTrainingLoadAlgorithms> = {},
): PmcTrainingLoadAlgorithms {
  return {
    computeTrainingImpulse: (durationMin, avgHr, maxHr, restingHr) => {
      if (maxHr <= restingHr || avgHr <= restingHr) return 0;
      return durationMin + avgHr - restingHr;
    },
    computeHeartRateTrainingStressScore: (durationMin, avgHr, maxHr, restingHr) => {
      if (maxHr <= restingHr || avgHr <= restingHr) return 0;
      return durationMin + avgHr - restingHr;
    },
    buildTrainingStressModel: () => null,
    ...overrides,
  };
}

function makeCalculator(
  overrides: Partial<PmcTrainingLoadAlgorithms> = {},
): PmcTrainingLoadCalculator {
  return new PmcTrainingLoadCalculator(makeAlgorithms(overrides));
}

describe("PmcTrainingLoadCalculator", () => {
  it("uses each activity's canonical stress without requiring heart rate", () => {
    const calculator = makeCalculator();
    const result = calculator.calculateDailyLoad({
      activities: [
        makeActivityRow({ id: "one", avg_hr: null }),
        makeActivityRow({ id: "two", avg_hr: null }),
      ],
      powerTssByActivity: new Map([
        ["one", 80],
        ["two", 25],
      ]),
      trainingStressModel: null,
      globalMaxHeartRate: null,
      restingHeartRate: 60,
    });
    expect(result.get("2026-05-20")).toBe(105);
  });
  it("keeps missing power and missing heart rate unavailable", () => {
    const result = makeCalculator().calculateDailyLoad({
      activities: [makeActivityRow({ avg_hr: null })],
      powerTssByActivity: new Map(),
      trainingStressModel: null,
      globalMaxHeartRate: 190,
      restingHeartRate: 60,
    });
    expect(result.size).toBe(0);
  });
  it("retains recorded zero power stress", () => {
    const result = makeCalculator().calculateDailyLoad({
      activities: [makeActivityRow()],
      powerTssByActivity: new Map([["activity-1", 0]]),
      trainingStressModel: null,
      globalMaxHeartRate: 190,
      restingHeartRate: 60,
    });
    expect(result.get("2026-05-20")).toBe(0);
  });
  it("falls back to the heart rate algorithm when canonical stress is unavailable", () => {
    const result = makeCalculator().calculateDailyLoad({
      activities: [makeActivityRow()],
      powerTssByActivity: new Map(),
      trainingStressModel: null,
      globalMaxHeartRate: 190,
      restingHeartRate: 60,
    });
    expect(result.get("2026-05-20")).toBe(150);
  });
  it("trains regression on canonical activity stress paired with observed heart rate", () => {
    const result = makeCalculator().buildTrainingStressModel(
      [makeActivityRow(), makeActivityRow({ id: "no-hr", avg_hr: null })],
      new Map([
        ["activity-1", 91],
        ["no-hr", 100],
      ]),
      190,
      60,
    );
    expect(result.pairedData).toEqual([{ trimp: 150, powerTss: 91 }]);
  });
  it("excludes absent, zero or negative stress and zero or negative training impulse from learned-model pairs", () => {
    const result = makeCalculator({
      computeTrainingImpulse: (durationMin) =>
        durationMin === 30 ? -10 : durationMin === 20 ? 0 : 150,
    }).buildTrainingStressModel(
      [
        makeActivityRow(),
        makeActivityRow({ id: "missing" }),
        makeActivityRow({ id: "zero" }),
        makeActivityRow({ id: "negative" }),
        makeActivityRow({ id: "zero-impulse", duration_min: 20 }),
        makeActivityRow({ id: "negative-impulse", duration_min: 30 }),
      ],
      new Map([
        ["activity-1", 91],
        ["zero", 0],
        ["negative", -1],
        ["zero-impulse", 80],
        ["negative-impulse", 80],
      ]),
      190,
      60,
    );
    expect(result.pairedData).toEqual([{ trimp: 150, powerTss: 91 }]);
  });
  it("uses the learned regression for heart rate fallback", () => {
    const result = makeCalculator().calculateDailyLoad({
      activities: [makeActivityRow()],
      powerTssByActivity: new Map(),
      trainingStressModel: { slope: 2, intercept: 10, r2: 0.9 },
      globalMaxHeartRate: 190,
      restingHeartRate: 60,
    });
    expect(result.get("2026-05-20")).toBe(310);
  });

  it("clamps negative learned heart-rate stress to recorded zero daily load", () => {
    const result = makeCalculator().calculateDailyLoad({
      activities: [makeActivityRow()],
      powerTssByActivity: new Map(),
      trainingStressModel: { slope: 2, intercept: -1000, r2: 0.9 },
      globalMaxHeartRate: 190,
      restingHeartRate: 60,
    });
    expect(result.get("2026-05-20")).toBe(0);
  });
});
