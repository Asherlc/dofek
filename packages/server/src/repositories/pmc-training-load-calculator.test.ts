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
    estimateThresholdPower: () => 190,
    computeTrainingImpulse: (durationMin, avgHr, maxHr, restingHr) => {
      if (maxHr <= restingHr || avgHr <= restingHr) return 0;
      return durationMin + avgHr - restingHr;
    },
    computePowerTrainingStressScore: (normalizedPower, thresholdPower, durationMin) => {
      if (thresholdPower <= 0) return 0;
      return normalizedPower + thresholdPower + durationMin;
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
  it("uses the injected heart-rate training stress algorithm", () => {
    const calculator = makeCalculator();

    const dailyLoad = calculator.calculateDailyLoad({
      activities: [makeActivityRow({ avg_power: null, power_samples: 0 })],
      normalizedPowerByActivity: new Map(),
      thresholdPower: null,
      trainingStressModel: null,
      globalMaxHeartRate: 190,
      restingHeartRate: 60,
    });

    expect(dailyLoad.get("2026-05-20")).toBe(150);
  });

  it("estimates threshold power from activity rows", () => {
    const calculator = makeCalculator({ estimateThresholdPower: () => 209 });

    const thresholdPower = calculator.estimateThresholdPower([
      makeActivityRow({ id: "low", avg_power: 190, power_samples: 3600 }),
      makeActivityRow({ id: "high", avg_power: 220, power_samples: 3600 }),
    ]);

    expect(thresholdPower).toBe(209);
  });

  it("uses power training stress when normalized power and threshold power exist", () => {
    const calculator = makeCalculator();

    const dailyLoad = calculator.calculateDailyLoad({
      activities: [makeActivityRow({ id: "power-activity" })],
      normalizedPowerByActivity: new Map([["power-activity", 220]]),
      thresholdPower: 190,
      trainingStressModel: null,
      globalMaxHeartRate: 190,
      restingHeartRate: 60,
    });

    expect(dailyLoad.get("2026-05-20")).toBe(470);
  });

  it("aggregates multiple activities on the same day", () => {
    const calculator = makeCalculator();

    const dailyLoad = calculator.calculateDailyLoad({
      activities: [
        makeActivityRow({ id: "morning", avg_power: null, power_samples: 0 }),
        makeActivityRow({ id: "evening", avg_power: null, power_samples: 0 }),
      ],
      normalizedPowerByActivity: new Map(),
      thresholdPower: null,
      trainingStressModel: null,
      globalMaxHeartRate: 190,
      restingHeartRate: 60,
    });

    const singleActivityLoad = calculator.calculateDailyLoad({
      activities: [makeActivityRow({ id: "single", avg_power: null, power_samples: 0 })],
      normalizedPowerByActivity: new Map(),
      thresholdPower: null,
      trainingStressModel: null,
      globalMaxHeartRate: 190,
      restingHeartRate: 60,
    });

    expect(dailyLoad.get("2026-05-20")).toBeCloseTo(
      (singleActivityLoad.get("2026-05-20") ?? 0) * 2,
    );
  });

  it("uses heart-rate training stress when power data is unavailable", () => {
    const calculator = makeCalculator();

    const dailyLoad = calculator.calculateDailyLoad({
      activities: [makeActivityRow({ avg_power: null, power_samples: 0 })],
      normalizedPowerByActivity: new Map(),
      thresholdPower: null,
      trainingStressModel: null,
      globalMaxHeartRate: 190,
      restingHeartRate: 60,
    });

    expect(dailyLoad.get("2026-05-20")).toBe(150);
  });

  it("uses heart-rate training stress when threshold power is unavailable", () => {
    const calculator = makeCalculator();

    const dailyLoad = calculator.calculateDailyLoad({
      activities: [makeActivityRow({ id: "power-without-threshold" })],
      normalizedPowerByActivity: new Map([["power-without-threshold", 220]]),
      thresholdPower: null,
      trainingStressModel: null,
      globalMaxHeartRate: 190,
      restingHeartRate: 60,
    });

    expect(dailyLoad.get("2026-05-20")).toBe(150);
  });

  it("uses heart-rate training stress when threshold power exists but normalized power is missing", () => {
    const calculator = makeCalculator();

    const dailyLoad = calculator.calculateDailyLoad({
      activities: [makeActivityRow({ id: "missing-normalized-power" })],
      normalizedPowerByActivity: new Map(),
      thresholdPower: 190,
      trainingStressModel: null,
      globalMaxHeartRate: 190,
      restingHeartRate: 60,
    });

    expect(dailyLoad.get("2026-05-20")).toBe(150);
  });

  it("uses heart-rate training stress when normalized power is zero", () => {
    const calculator = makeCalculator();

    const dailyLoad = calculator.calculateDailyLoad({
      activities: [makeActivityRow({ id: "zero-normalized-power" })],
      normalizedPowerByActivity: new Map([["zero-normalized-power", 0]]),
      thresholdPower: 190,
      trainingStressModel: null,
      globalMaxHeartRate: 190,
      restingHeartRate: 60,
    });

    expect(dailyLoad.get("2026-05-20")).toBe(150);
  });

  it("uses a learned training stress model for heart-rate-only activities when one exists", () => {
    const calculator = makeCalculator();
    const trainingImpulse = 150;

    const dailyLoad = calculator.calculateDailyLoad({
      activities: [makeActivityRow({ avg_power: null, power_samples: 0 })],
      normalizedPowerByActivity: new Map(),
      thresholdPower: 190,
      trainingStressModel: { slope: 1.5, intercept: 10, r2: 0.75 },
      globalMaxHeartRate: 190,
      restingHeartRate: 60,
    });

    expect(dailyLoad.get("2026-05-20")).toBe(1.5 * trainingImpulse + 10);
  });

  it("does not allow a learned model to produce negative daily load", () => {
    const calculator = makeCalculator();

    const dailyLoad = calculator.calculateDailyLoad({
      activities: [makeActivityRow({ avg_power: null, power_samples: 0 })],
      normalizedPowerByActivity: new Map(),
      thresholdPower: 190,
      trainingStressModel: { slope: 0, intercept: -20, r2: 0.75 },
      globalMaxHeartRate: 190,
      restingHeartRate: 60,
    });

    expect(dailyLoad.get("2026-05-20")).toBe(0);
  });

  it("builds paired model inputs only from activities with positive normalized power", () => {
    const calculator = makeCalculator();

    const result = calculator.buildTrainingStressModel(
      [
        makeActivityRow({ id: "positive-power" }),
        makeActivityRow({ id: "zero-power" }),
        makeActivityRow({ id: "missing-power" }),
      ],
      new Map([
        ["positive-power", 220],
        ["zero-power", 0],
      ]),
      190,
      190,
      60,
    );

    expect(result.pairedData).toHaveLength(1);
    expect(result.pairedData[0]?.trimp).toBeGreaterThan(0);
    expect(result.pairedData[0]?.powerTss).toBeGreaterThan(0);
    expect(result.trainingStressModel).toBeNull();
  });

  it("does not build paired model inputs from activities with zero heart-rate load", () => {
    const calculator = makeCalculator();

    const result = calculator.buildTrainingStressModel(
      [makeActivityRow({ id: "zero-heart-rate-load", avg_hr: 60 })],
      new Map([["zero-heart-rate-load", 220]]),
      190,
      190,
      60,
    );

    expect(result).toEqual({ trainingStressModel: null, pairedData: [] });
  });

  it("does not build paired model inputs from activities with zero power training stress", () => {
    const calculator = makeCalculator();

    const result = calculator.buildTrainingStressModel(
      [makeActivityRow({ id: "zero-power-training-stress" })],
      new Map([["zero-power-training-stress", 220]]),
      0,
      190,
      60,
    );

    expect(result).toEqual({ trainingStressModel: null, pairedData: [] });
  });

  it("does not build paired model inputs without threshold power", () => {
    const calculator = makeCalculator();

    const result = calculator.buildTrainingStressModel(
      [makeActivityRow({ id: "positive-power" })],
      new Map([["positive-power", 220]]),
      null,
      190,
      60,
    );

    expect(result).toEqual({ trainingStressModel: null, pairedData: [] });
  });
});
