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
  currentEftp: number | null;
  activityRows: PmcActivityRow[];
  normalizedPowerRows: PmcNormalizedPowerRow[];
  queryDays: number;
  displayDays: number;
}

interface PmcChartModel {
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
    const powerTssByActivity = new Map(
      input.normalizedPowerRows.flatMap((row) =>
        row.power_tss == null ? [] : [[row.activity_id, row.power_tss] as const],
      ),
    );
    const thresholdPower = input.currentEftp;
    const unsupportedCount = input.activityRows.filter(
      (activity) => !powerTssByActivity.has(activity.id),
    ).length;
    if (unsupportedCount > 0) {
      return {
        data: [],
        unavailableReason: `Training load is unavailable for ${unsupportedCount} cycling ${unsupportedCount === 1 ? "activity" : "activities"}: power-derived training stress is missing. Record cycling power with a usable threshold to calculate training load.`,
        model: { ftp: thresholdPower },
      };
    }
    const dailyLoad = this.#trainingLoadCalculator.calculateDailyLoad({
      activities: input.activityRows,
      powerTssByActivity,
    });
    const data =
      dailyLoad.size === 0
        ? []
        : this.#ewmaCalculator.compute({
            dailyLoad,
            queryDays: input.queryDays,
            displayDays: input.displayDays,
          });
    const model: PmcChartModel = { ftp: thresholdPower };

    return { data, model, unavailableReason: null };
  }
}
