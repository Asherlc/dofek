export interface PmcActivityRow {
  global_max_hr: number | null;
  resting_hr: number;
  id: string;
  date: string;
  duration_min: number;
  avg_hr: number | null;
  max_hr: number | null;
  avg_power: number | null;
  power_samples: number;
  hr_samples: number;
}

export interface PmcNormalizedPowerRow {
  activity_id: string;
  power_tss: number | null;
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

export interface PmcTrainingLoadAlgorithms {
  computeTrainingImpulse(
    durationMin: number,
    avgHr: number,
    maxHr: number,
    restingHr: number,
  ): number;
  computeHeartRateTrainingStressScore(
    durationMin: number,
    avgHr: number,
    maxHr: number,
    restingHr: number,
  ): number;
  buildTrainingStressModel(
    pairedData: { trimp: number; powerTss: number }[],
  ): PmcTrainingStressModel | null;
}

interface PmcDailyLoadInput {
  activities: PmcActivityRow[];
  powerTssByActivity: Map<string, number>;
  trainingStressModel: PmcTrainingStressModel | null;
  globalMaxHeartRate: number | null;
  restingHeartRate: number;
}

export function usablePmcHeartRate(
  activity: Pick<PmcActivityRow, "avg_hr">,
  maximum: number | null,
  resting: number,
) {
  if (activity.avg_hr == null || activity.avg_hr <= 0 || maximum == null || maximum <= resting) {
    return null;
  }
  return { average: activity.avg_hr, maximum, resting };
}

export class PmcTrainingLoadCalculator {
  readonly #algorithms: PmcTrainingLoadAlgorithms;

  constructor(algorithms: PmcTrainingLoadAlgorithms) {
    this.#algorithms = algorithms;
  }

  buildTrainingStressModel(
    activities: PmcActivityRow[],
    powerTssByActivity: Map<string, number>,
    globalMaxHeartRate: number | null,
    restingHeartRate: number,
  ): PmcTrainingStressModelResult {
    const pairedData: { trimp: number; powerTss: number }[] = [];
    for (const activity of activities) {
      const powerTss = powerTssByActivity.get(activity.id);
      const heartRate = usablePmcHeartRate(activity, globalMaxHeartRate, restingHeartRate);
      if (powerTss == null || powerTss <= 0 || heartRate == null) continue;
      const trimp = this.#algorithms.computeTrainingImpulse(
        activity.duration_min,
        heartRate.average,
        heartRate.maximum,
        heartRate.resting,
      );
      if (trimp > 0) pairedData.push({ trimp, powerTss });
    }
    return {
      trainingStressModel: this.#algorithms.buildTrainingStressModel(pairedData),
      pairedData,
    };
  }

  calculateDailyLoad(input: PmcDailyLoadInput): Map<string, number> {
    const dailyLoad = new Map<string, number>();
    for (const activity of input.activities) {
      let trainingStressScore = input.powerTssByActivity.get(activity.id);
      if (trainingStressScore == null) {
        const heartRate = usablePmcHeartRate(
          activity,
          input.globalMaxHeartRate,
          input.restingHeartRate,
        );
        if (heartRate == null) continue;
        if (input.trainingStressModel != null) {
          const trimp = this.#algorithms.computeTrainingImpulse(
            activity.duration_min,
            heartRate.average,
            heartRate.maximum,
            heartRate.resting,
          );
          trainingStressScore = Math.max(
            0,
            input.trainingStressModel.slope * trimp + input.trainingStressModel.intercept,
          );
        } else {
          trainingStressScore = this.#algorithms.computeHeartRateTrainingStressScore(
            activity.duration_min,
            heartRate.average,
            heartRate.maximum,
            heartRate.resting,
          );
        }
      }
      dailyLoad.set(activity.date, (dailyLoad.get(activity.date) ?? 0) + trainingStressScore);
    }
    return dailyLoad;
  }
}
