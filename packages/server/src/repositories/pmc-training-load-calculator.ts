import { TrainingStressCalculator } from "@dofek/training/training-load";

export interface PmcActivityRow {
  global_max_hr: number | null;
  resting_hr: number;
  id: string;
  date: string;
  duration_min: number;
  avg_hr: number;
  max_hr: number;
  avg_power: number | null;
  power_samples: number;
  hr_samples: number;
}

export interface PmcNormalizedPowerRow {
  activity_id: string;
  np: number;
}

export interface PmcTrainingStressModel {
  slope: number;
  intercept: number;
  r2: number;
}

interface PmcTrainingStressModelResult {
  trainingStressModel: PmcTrainingStressModel | null;
  pairedData: { trimp: number; powerTss: number }[];
}

interface PmcDailyLoadInput {
  activities: PmcActivityRow[];
  normalizedPowerByActivity: Map<string, number>;
  thresholdPower: number | null;
  trainingStressModel: PmcTrainingStressModel | null;
  globalMaxHeartRate: number;
  restingHeartRate: number;
}

export class PmcTrainingLoadCalculator {
  readonly #calculator: TrainingStressCalculator;

  static fromTrainingImpulseConstants(
    genderFactor: number,
    exponent: number,
  ): PmcTrainingLoadCalculator {
    return new PmcTrainingLoadCalculator(new TrainingStressCalculator(genderFactor, exponent));
  }

  constructor(calculator: TrainingStressCalculator) {
    this.#calculator = calculator;
  }

  estimateThresholdPower(activities: PmcActivityRow[]): number | null {
    return TrainingStressCalculator.estimateFtp(activities);
  }

  buildTrainingStressModel(
    activities: PmcActivityRow[],
    normalizedPowerByActivity: Map<string, number>,
    thresholdPower: number | null,
    globalMaxHeartRate: number,
    restingHeartRate: number,
  ): PmcTrainingStressModelResult {
    const pairedData: { trimp: number; powerTss: number }[] = [];

    if (thresholdPower != null) {
      for (const activity of activities) {
        const durationMin = Number(activity.duration_min);
        const avgHr = Number(activity.avg_hr);
        const normalizedPower = normalizedPowerByActivity.get(activity.id);

        if (normalizedPower != null && normalizedPower > 0) {
          const trimp = this.#calculator.computeTrimp(
            durationMin,
            avgHr,
            globalMaxHeartRate,
            restingHeartRate,
          );
          const powerTss = TrainingStressCalculator.computePowerTss(
            normalizedPower,
            thresholdPower,
            durationMin,
          );
          if (trimp > 0 && powerTss > 0) {
            pairedData.push({ trimp, powerTss });
          }
        }
      }
    }

    return {
      trainingStressModel: TrainingStressCalculator.buildTssModel(pairedData),
      pairedData,
    };
  }

  calculateDailyLoad(input: PmcDailyLoadInput): Map<string, number> {
    const dailyLoad = new Map<string, number>();

    for (const activity of input.activities) {
      const durationMin = Number(activity.duration_min);
      const avgHr = Number(activity.avg_hr);
      const normalizedPower = input.normalizedPowerByActivity.get(activity.id);

      let trainingStressScore: number;

      if (input.thresholdPower != null && normalizedPower != null && normalizedPower > 0) {
        trainingStressScore = TrainingStressCalculator.computePowerTss(
          normalizedPower,
          input.thresholdPower,
          durationMin,
        );
      } else if (input.trainingStressModel != null) {
        const trimp = this.#calculator.computeTrimp(
          durationMin,
          avgHr,
          input.globalMaxHeartRate,
          input.restingHeartRate,
        );
        trainingStressScore = Math.max(
          0,
          input.trainingStressModel.slope * trimp + input.trainingStressModel.intercept,
        );
      } else {
        trainingStressScore = this.#calculator.computeHrTss(
          durationMin,
          avgHr,
          input.globalMaxHeartRate,
          input.restingHeartRate,
        );
      }

      const dateStr = String(activity.date);
      dailyLoad.set(dateStr, (dailyLoad.get(dateStr) ?? 0) + trainingStressScore);
    }

    return dailyLoad;
  }
}
