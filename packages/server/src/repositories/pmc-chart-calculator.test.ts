import { describe, expect, it } from "vitest";
import { PmcChartCalculator } from "./pmc-chart-calculator.ts";
import {
  type PmcActivityRow,
  type PmcNormalizedPowerRow,
  PmcTrainingLoadCalculator,
} from "./pmc-training-load-calculator.ts";

function makeTrainingLoadCalculator(): PmcTrainingLoadCalculator {
  return new PmcTrainingLoadCalculator({
    estimateThresholdPower: (activities) =>
      activities.some((activity) => activity.avg_power != null && activity.power_samples > 0)
        ? 190
        : null,
    computeTrainingImpulse: (durationMin, avgHr, maxHr, restingHr) => {
      if (maxHr <= restingHr || avgHr <= restingHr) return 0;
      return durationMin * ((avgHr - restingHr) / (maxHr - restingHr));
    },
    computePowerTrainingStressScore: (normalizedPower, thresholdPower, durationMin) => {
      if (thresholdPower <= 0) return 0;
      return (normalizedPower / thresholdPower) * durationMin;
    },
    computeHeartRateTrainingStressScore: (durationMin, avgHr, maxHr, restingHr) => {
      if (maxHr <= restingHr || avgHr <= restingHr) return 0;
      return durationMin * ((avgHr - restingHr) / (maxHr - restingHr));
    },
    buildTrainingStressModel: (pairedData) =>
      pairedData.length >= 10 ? { slope: 1, intercept: 0, r2: 0.9996 } : null,
  });
}

function makeCalculator(): PmcChartCalculator {
  return new PmcChartCalculator({
    chronicTrainingLoadDays: 42,
    acuteTrainingLoadDays: 7,
    trainingLoadCalculator: makeTrainingLoadCalculator(),
  });
}

function makeActivityRow(overrides: Partial<PmcActivityRow> = {}): PmcActivityRow {
  const date = new Date();
  date.setDate(date.getDate() - 2);

  return {
    global_max_hr: 190,
    resting_hr: 60,
    id: "activity-1",
    date: date.toISOString().slice(0, 10),
    duration_min: 60,
    avg_hr: 150,
    max_hr: 180,
    avg_power: 200,
    power_samples: 3600,
    hr_samples: 3600,
    ...overrides,
  };
}

function makeLearnedModelInput(): {
  activityRows: PmcActivityRow[];
  normalizedPowerRows: PmcNormalizedPowerRow[];
} {
  const thresholdPower = 190;
  const globalMaxHeartRate = 190;
  const restingHeartRate = 60;
  const genderFactor = 1.92;
  const exponent = 1.67;
  const activityRows: PmcActivityRow[] = [];
  const normalizedPowerRows: PmcNormalizedPowerRow[] = [];

  for (let index = 0; index < 10; index += 1) {
    const avgHeartRate = 120 + index * 5;
    const deltaHeartRateRatio =
      (avgHeartRate - restingHeartRate) / (globalMaxHeartRate - restingHeartRate);
    const trimp =
      60 * deltaHeartRateRatio * genderFactor * Math.exp(exponent * deltaHeartRateRatio);
    const powerTss = trimp * 1.25 + 4;
    const normalizedPower = thresholdPower * Math.sqrt(powerTss / 100);
    const date = new Date();
    date.setDate(date.getDate() - 20 + index);
    const activityId = `learned-model-${index}`;

    activityRows.push(
      makeActivityRow({
        id: activityId,
        date: date.toISOString().slice(0, 10),
        avg_hr: avgHeartRate,
        avg_power: 200,
      }),
    );
    normalizedPowerRows.push({ activity_id: activityId, np: normalizedPower });
  }

  return { activityRows, normalizedPowerRows };
}

describe("PmcChartCalculator", () => {
  it("returns the generic empty model when there is no global max heart rate", () => {
    const calculator = makeCalculator();

    const result = calculator.buildChart({
      activityRows: [makeActivityRow({ global_max_hr: null })],
      normalizedPowerRows: [],
      queryDays: 407,
      displayDays: 90,
    });

    expect(result).toEqual({
      data: [],
      model: { type: "generic", pairedActivities: 0, r2: null, ftp: null },
    });
  });

  it("builds chart data and threshold power from activity rows", () => {
    const calculator = makeCalculator();

    const result = calculator.buildChart({
      activityRows: [makeActivityRow({ id: "power-activity", avg_power: 200 })],
      normalizedPowerRows: [{ activity_id: "power-activity", np: 220 }],
      queryDays: 407,
      displayDays: 90,
    });

    expect(result.model.ftp).toBe(190);
    expect(result.data.length).toBeGreaterThan(0);
  });

  it("returns rounded learned model metadata when enough paired activities fit", () => {
    const calculator = makeCalculator();
    const { activityRows, normalizedPowerRows } = makeLearnedModelInput();

    const result = calculator.buildChart({
      activityRows,
      normalizedPowerRows,
      queryDays: 407,
      displayDays: 90,
    });

    expect(result.model).toEqual({
      type: "learned",
      pairedActivities: 10,
      r2: 1,
      ftp: 190,
    });
  });

  it("uses resting heart rate from activity rows when calculating load", () => {
    const lowRestingCalculator = makeCalculator();
    const highRestingCalculator = makeCalculator();

    const lowRestingResult = lowRestingCalculator.buildChart({
      activityRows: [makeActivityRow({ avg_power: null, power_samples: 0, resting_hr: 40 })],
      normalizedPowerRows: [],
      queryDays: 407,
      displayDays: 90,
    });
    const highRestingResult = highRestingCalculator.buildChart({
      activityRows: [makeActivityRow({ avg_power: null, power_samples: 0, resting_hr: 80 })],
      normalizedPowerRows: [],
      queryDays: 407,
      displayDays: 90,
    });

    const activityDate = lowRestingResult.data.find((point) => point.load > 0)?.date;
    const lowRestingLoad =
      lowRestingResult.data.find((point) => point.date === activityDate)?.load ?? 0;
    const highRestingLoad =
      highRestingResult.data.find((point) => point.date === activityDate)?.load ?? 0;

    expect(lowRestingLoad).toBeGreaterThan(0);
    expect(highRestingLoad).toBeGreaterThan(0);
    expect(lowRestingLoad).not.toBe(highRestingLoad);
  });
});
