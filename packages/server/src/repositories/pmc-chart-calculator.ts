import { PmcEwmaCalculator } from "./pmc-ewma-calculator.ts";
import type {
  PmcActivityRow,
  PmcNormalizedPowerRow,
  PmcTrainingLoadCalculator,
} from "./pmc-training-load-calculator.ts";

interface PmcChartCalculatorOptions {
  chronicTrainingLoadDays: number;
  acuteTrainingLoadDays: number;
  trainingLoadCalculator: PmcTrainingLoadCalculator;
}

interface PmcChartInput {
  activityRows: PmcActivityRow[];
  normalizedPowerRows: PmcNormalizedPowerRow[];
  queryDays: number;
  displayDays: number;
}

interface PmcChartModel {
  type: "learned" | "generic";
  pairedActivities: number;
  r2: number | null;
  ftp: number | null;
}

interface PmcChart {
  data: ReturnType<PmcEwmaCalculator["compute"]>;
  model: PmcChartModel;
}

export class PmcChartCalculator {
  readonly #trainingLoadCalculator: PmcTrainingLoadCalculator;
  readonly #ewmaCalculator: PmcEwmaCalculator;

  constructor(options: PmcChartCalculatorOptions) {
    this.#trainingLoadCalculator = options.trainingLoadCalculator;
    this.#ewmaCalculator = new PmcEwmaCalculator({
      chronicTrainingLoadDays: options.chronicTrainingLoadDays,
      acuteTrainingLoadDays: options.acuteTrainingLoadDays,
    });
  }

  buildChart(input: PmcChartInput): PmcChart {
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
    const thresholdPower = this.#trainingLoadCalculator.estimateThresholdPower(input.activityRows);
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
    const model: PmcChartModel =
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
