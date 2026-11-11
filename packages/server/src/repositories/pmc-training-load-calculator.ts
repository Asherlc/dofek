export interface PmcActivityRow {
  id: string;
  date: string;
}

export interface PmcNormalizedPowerRow {
  activity_id: string;
  power_tss: number | null;
}

interface PmcDailyLoadInput {
  activities: PmcActivityRow[];
  powerTssByActivity: Map<string, number>;
}

export class PmcTrainingLoadCalculator {
  calculateDailyLoad(input: PmcDailyLoadInput): Map<string, number> {
    const dailyLoad = new Map<string, number>();
    for (const activity of input.activities) {
      const trainingStressScore = input.powerTssByActivity.get(activity.id);
      if (trainingStressScore == null) continue;
      dailyLoad.set(activity.date, (dailyLoad.get(activity.date) ?? 0) + trainingStressScore);
    }
    return dailyLoad;
  }
}
