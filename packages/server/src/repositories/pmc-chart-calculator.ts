import type { PmcChartResult, TssModelInfo } from "@dofek/training/pmc";
import { TrainingStressCalculator } from "@dofek/training/training-load";
import { PmcEwmaCalculator } from "./pmc-ewma-calculator.ts";
import {
  type PmcActivityRow,
  type PmcNormalizedPowerRow,
  PmcTrainingLoadCalculator,
} from "./pmc-training-load-calculator.ts";

interface PmcChartCalculatorOptions {
  chronicTrainingLoadDays: number;
  acuteTrainingLoadDays: number;
  genderFactor: number;
  exponent: number;
}

interface PmcChartInput {
  activityRows: PmcActivityRow[];
  normalizedPowerRows: PmcNormalizedPowerRow[];
  queryDays: number;
  displayDays: number;
}

export class PmcChartCalculator {
  readonly #trainingLoadCalculator: PmcTrainingLoadCalculator;
  readonly #ewmaCalculator: PmcEwmaCalculator;

  constructor(options: PmcChartCalculatorOptions) {
    this.#trainingLoadCalculator = new PmcTrainingLoadCalculator(
      new TrainingStressCalculator(options.genderFactor, options.exponent),
    );
    this.#ewmaCalculator = new PmcEwmaCalculator({
      chronicTrainingLoadDays: options.chronicTrainingLoadDays,
      acuteTrainingLoadDays: options.acuteTrainingLoadDays,
    });
  }

  buildChart(input: PmcChartInput): PmcChartResult {
    const globalMaxHeartRate =
      input.activityRows.length > 0 ? Number(input.activityRows[0]?.global_max_hr) : null;
    if (!globalMaxHeartRate) {
      return {
        data: [],
        model: { type: "generic", pairedActivities: 0, r2: null, ftp: null },
      };
    }

    const restingHeartRate =
      input.activityRows.length > 0 ? Number(input.activityRows[0]?.resting_hr) : 60;
    const normalizedPowerByActivity = new Map(
      input.normalizedPowerRows.map((row) => [row.activity_id, Number(row.np)]),
    );
    const thresholdPower = TrainingStressCalculator.estimateFtp(input.activityRows);
    const { trainingStressModel, pairedData } =
      this.#trainingLoadCalculator.buildTrainingStressModel(
        input.activityRows,
        normalizedPowerByActivity,
        thresholdPower,
        globalMaxHeartRate,
        restingHeartRate,
      );
    const dailyLoad = this.#trainingLoadCalculator.calculateDailyLoad({
      activities: input.activityRows,
      normalizedPowerByActivity,
      thresholdPower,
      trainingStressModel,
      globalMaxHeartRate,
      restingHeartRate,
    });
    const data = this.#ewmaCalculator.compute({
      dailyLoad,
      queryDays: input.queryDays,
      displayDays: input.displayDays,
    });
    const model: TssModelInfo =
      trainingStressModel != null
        ? {
            type: "learned",
            pairedActivities: pairedData.length,
            r2: Math.round(trainingStressModel.r2 * 1000) / 1000,
            ftp: thresholdPower,
          }
        : {
            type: "generic",
            pairedActivities: pairedData.length,
            r2: null,
            ftp: thresholdPower,
          };

    return { data, model };
  }
}
