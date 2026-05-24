import { TrainingStressCalculator } from "@dofek/training/training-load";
import { describe, expect, it, vi } from "vitest";
import { PmcChartCalculator } from "./pmc-chart-calculator.ts";
import type { PmcActivityRow } from "./pmc-training-load-calculator.ts";

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

describe("PmcChartCalculator", () => {
  it("returns the generic empty model when there is no global max heart rate", () => {
    const calculator = new PmcChartCalculator({
      chronicTrainingLoadDays: 42,
      acuteTrainingLoadDays: 7,
      genderFactor: 1.92,
      exponent: 1.67,
    });

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
    const calculator = new PmcChartCalculator({
      chronicTrainingLoadDays: 42,
      acuteTrainingLoadDays: 7,
      genderFactor: 1.92,
      exponent: 1.67,
    });

    const result = calculator.buildChart({
      activityRows: [makeActivityRow({ id: "power-activity", avg_power: 200 })],
      normalizedPowerRows: [{ activity_id: "power-activity", np: 220 }],
      queryDays: 407,
      displayDays: 90,
    });

    expect(result.model.ftp).toBe(190);
    expect(result.data.length).toBeGreaterThan(0);
  });

  it("returns rounded learned model metadata when model building succeeds", () => {
    const buildModelSpy = vi
      .spyOn(TrainingStressCalculator, "buildTssModel")
      .mockReturnValue({ slope: 1.25, intercept: 4, r2: 0.4567 });

    try {
      const calculator = new PmcChartCalculator({
        chronicTrainingLoadDays: 42,
        acuteTrainingLoadDays: 7,
        genderFactor: 1.92,
        exponent: 1.67,
      });

      const result = calculator.buildChart({
        activityRows: [makeActivityRow({ id: "learned-model", avg_power: 200 })],
        normalizedPowerRows: [{ activity_id: "learned-model", np: 220 }],
        queryDays: 407,
        displayDays: 90,
      });

      expect(buildModelSpy).toHaveBeenCalledWith([
        expect.objectContaining({ trimp: expect.any(Number), powerTss: expect.any(Number) }),
      ]);
      expect(result.model).toEqual({
        type: "learned",
        pairedActivities: 1,
        r2: 0.457,
        ftp: 190,
      });
    } finally {
      buildModelSpy.mockRestore();
    }
  });

  it("uses resting heart rate from activity rows when calculating load", () => {
    const lowRestingCalculator = new PmcChartCalculator({
      chronicTrainingLoadDays: 42,
      acuteTrainingLoadDays: 7,
      genderFactor: 1.92,
      exponent: 1.67,
    });
    const highRestingCalculator = new PmcChartCalculator({
      chronicTrainingLoadDays: 42,
      acuteTrainingLoadDays: 7,
      genderFactor: 1.92,
      exponent: 1.67,
    });

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
