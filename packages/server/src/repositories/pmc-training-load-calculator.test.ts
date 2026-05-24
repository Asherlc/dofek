import { TrainingStressCalculator } from "@dofek/training/training-load";
import { describe, expect, it } from "vitest";
import { type PmcActivityRow, PmcTrainingLoadCalculator } from "./pmc-training-load-calculator.ts";

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

describe("PmcTrainingLoadCalculator", () => {
  it("uses power training stress when normalized power and threshold power exist", () => {
    const calculator = new PmcTrainingLoadCalculator(new TrainingStressCalculator(1.92, 1.67));

    const dailyLoad = calculator.calculateDailyLoad({
      activities: [makeActivityRow({ id: "power-activity" })],
      normalizedPowerByActivity: new Map([["power-activity", 220]]),
      thresholdPower: 190,
      trainingStressModel: null,
      globalMaxHeartRate: 190,
      restingHeartRate: 60,
    });

    expect(dailyLoad.get("2026-05-20")).toBeCloseTo(
      TrainingStressCalculator.computePowerTss(220, 190, 60),
    );
  });

  it("aggregates multiple activities on the same day", () => {
    const calculator = new PmcTrainingLoadCalculator(new TrainingStressCalculator(1.92, 1.67));

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
    const trainingStressCalculator = new TrainingStressCalculator(1.92, 1.67);
    const calculator = new PmcTrainingLoadCalculator(trainingStressCalculator);

    const dailyLoad = calculator.calculateDailyLoad({
      activities: [makeActivityRow({ avg_power: null, power_samples: 0 })],
      normalizedPowerByActivity: new Map(),
      thresholdPower: null,
      trainingStressModel: null,
      globalMaxHeartRate: 190,
      restingHeartRate: 60,
    });

    expect(dailyLoad.get("2026-05-20")).toBeCloseTo(
      trainingStressCalculator.computeHrTss(60, 150, 190, 60),
    );
  });

  it("uses a learned training stress model for heart-rate-only activities when one exists", () => {
    const trainingStressCalculator = new TrainingStressCalculator(1.92, 1.67);
    const calculator = new PmcTrainingLoadCalculator(trainingStressCalculator);
    const trimp = trainingStressCalculator.computeTrimp(60, 150, 190, 60);

    const dailyLoad = calculator.calculateDailyLoad({
      activities: [makeActivityRow({ avg_power: null, power_samples: 0 })],
      normalizedPowerByActivity: new Map(),
      thresholdPower: 190,
      trainingStressModel: { slope: 1.5, intercept: 10, r2: 0.75 },
      globalMaxHeartRate: 190,
      restingHeartRate: 60,
    });

    expect(dailyLoad.get("2026-05-20")).toBeCloseTo(1.5 * trimp + 10);
  });

  it("does not allow a learned model to produce negative daily load", () => {
    const calculator = new PmcTrainingLoadCalculator(new TrainingStressCalculator(1.92, 1.67));

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
    const calculator = new PmcTrainingLoadCalculator(new TrainingStressCalculator(1.92, 1.67));

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

  it("does not build paired model inputs without threshold power", () => {
    const calculator = new PmcTrainingLoadCalculator(new TrainingStressCalculator(1.92, 1.67));

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
