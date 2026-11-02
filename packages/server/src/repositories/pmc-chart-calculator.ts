import { PmcEwmaCalculator } from "./pmc-ewma-calculator.ts";
import {
  type PmcActivityRow,
  type PmcNormalizedPowerRow,
  type PmcTrainingLoadCalculator,
  usablePmcHeartRate,
} from "./pmc-training-load-calculator.ts";

interface PmcChartCalculatorOptions {
  chronicTrainingLoadDays: number;
  acuteTrainingLoadDays: number;
  trainingLoadCalculator: PmcTrainingLoadCalculator;
}

interface PmcChartInput {
  currentEftp: number | null;
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
  unavailableReason: string | null;
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
    const restingHeartRate =
      input.activityRows.length > 0 ? Number(input.activityRows[0]?.resting_hr) : 60;
    const powerTssByActivity = new Map(
      input.normalizedPowerRows.flatMap((row) =>
        row.power_tss == null ? [] : [[row.activity_id, row.power_tss] as const],
      ),
    );
    const thresholdPower = input.currentEftp;
    const unsupportedCount = input.activityRows.filter(
      (activity) =>
        !powerTssByActivity.has(activity.id) &&
        usablePmcHeartRate(activity, globalMaxHeartRate, restingHeartRate) == null,
    ).length;
    if (unsupportedCount > 0) {
      return {
        data: [],
        unavailableReason: `Training load is unavailable for ${unsupportedCount} cycling ${unsupportedCount === 1 ? "activity" : "activities"}: computed power stress and usable heart-rate data are missing.`,
        model: { type: "generic", pairedActivities: 0, r2: null, ftp: thresholdPower },
      };
    }
    const { trainingStressModel, pairedData } =
      this.#trainingLoadCalculator.buildTrainingStressModel(
        input.activityRows,
        powerTssByActivity,
        globalMaxHeartRate,
        restingHeartRate,
      );
    const dailyLoad = this.#trainingLoadCalculator.calculateDailyLoad({
      activities: input.activityRows,
      powerTssByActivity,
      trainingStressModel,
      globalMaxHeartRate,
      restingHeartRate,
    });
    const data =
      dailyLoad.size === 0
        ? []
        : this.#ewmaCalculator.compute({
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

    return { data, model, unavailableReason: null };
  }
}
