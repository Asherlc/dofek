import {
  type CanonicalActivityType,
  createActivityTypeMapper,
  POLAR_SPORT_MAP,
} from "@dofek/training/training";
import type {
  ParsedPolarActivity,
  ParsedPolarDailyMetrics,
  ParsedPolarSleep,
  ParsedPolarSleepStage,
  PolarDailyActivity,
  PolarExercise,
  PolarNightlyRecharge,
  PolarSleep,
} from "./types.ts";

const mapPolarType = createActivityTypeMapper(POLAR_SPORT_MAP);

export function mapPolarSport(sport: string): CanonicalActivityType {
  return mapPolarType(sport.toLowerCase());
}

export function parsePolarDuration(isoDuration: string): number {
  const hoursMatch = /(\d+(?:\.\d+)?)H/.exec(isoDuration);
  const minutesMatch = /(\d+(?:\.\d+)?)M/.exec(isoDuration);
  const secondsMatch = /(\d+(?:\.\d+)?)S/.exec(isoDuration);

  const hours = hoursMatch?.[1] ? Number.parseFloat(hoursMatch[1]) : 0;
  const minutes = minutesMatch?.[1] ? Number.parseFloat(minutesMatch[1]) : 0;
  const seconds = secondsMatch?.[1] ? Number.parseFloat(secondsMatch[1]) : 0;

  return hours * 3600 + minutes * 60 + seconds;
}

export function parsePolarExercise(exercise: PolarExercise): ParsedPolarActivity {
  const durationSeconds = parsePolarDuration(exercise.duration);
  const startedAt = new Date(exercise.start_time);
  const endedAt = new Date(startedAt.getTime() + durationSeconds * 1000);

  return {
    externalId: exercise.id,
    activityType: mapPolarSport(exercise.sport),
    name: exercise.detailed_sport_info,
    startedAt,
    endedAt,
    durationSeconds,
    distanceMeters: exercise.distance,
    calories: exercise.calories,
    avgHeartRate: exercise.heart_rate?.average,
    maxHeartRate: exercise.heart_rate?.maximum,
  };
}

export function parsePolarSleep(sleep: PolarSleep): ParsedPolarSleep {
  const lightMinutes = Math.round(sleep.light_sleep / 60);
  const deepMinutes = Math.round(sleep.deep_sleep / 60);
  const remMinutes = Math.round(sleep.rem_sleep / 60);
  const awakeMinutes = Math.round(sleep.total_interruption_duration / 60);

  return {
    externalId: sleep.date,
    startedAt: new Date(sleep.sleep_start_time),
    endedAt: new Date(sleep.sleep_end_time),
    durationMinutes: lightMinutes + deepMinutes + remMinutes,
    lightMinutes,
    deepMinutes,
    remMinutes,
    awakeMinutes,
  };
}

const POLAR_HYPNOGRAM_STAGE_MAP: Record<number, "deep" | "light" | "rem" | "awake"> = {
  1: "deep",
  2: "light",
  3: "rem",
  4: "awake",
  5: "awake",
};

export function parsePolarSleepStages(
  sleepStartTime: string,
  hypnogram: Record<string, number>,
): ParsedPolarSleepStage[] {
  const startTimeMillis = new Date(sleepStartTime).getTime();
  const sortedEntries = Object.entries(hypnogram)
    .map(([minuteString, stageValue]) => ({
      minute: Number(minuteString),
      stage: POLAR_HYPNOGRAM_STAGE_MAP[stageValue],
    }))
    .filter(
      (entry): entry is { minute: number; stage: "deep" | "light" | "rem" | "awake" } =>
        entry.stage != null,
    )
    .sort((firstEntry, secondEntry) => firstEntry.minute - secondEntry.minute);

  const firstEntry = sortedEntries[0];
  if (!firstEntry) return [];

  const stageIntervals: ParsedPolarSleepStage[] = [];
  let currentStage = firstEntry.stage;
  let currentStartMinute = firstEntry.minute;
  let previousMinute = firstEntry.minute;

  for (let entryIndex = 1; entryIndex < sortedEntries.length; entryIndex++) {
    const entry = sortedEntries[entryIndex];
    if (!entry) continue;

    if (entry.stage !== currentStage || entry.minute !== previousMinute + 1) {
      stageIntervals.push({
        stage: currentStage,
        startedAt: new Date(startTimeMillis + currentStartMinute * 60000),
        endedAt: new Date(startTimeMillis + (previousMinute + 1) * 60000),
      });
      currentStage = entry.stage;
      currentStartMinute = entry.minute;
    }

    previousMinute = entry.minute;
  }

  stageIntervals.push({
    stage: currentStage,
    startedAt: new Date(startTimeMillis + currentStartMinute * 60000),
    endedAt: new Date(startTimeMillis + (previousMinute + 1) * 60000),
  });

  return stageIntervals;
}

export function parsePolarDailyActivity(
  dailyActivity: PolarDailyActivity,
  nightlyRecharge: PolarNightlyRecharge | null,
): ParsedPolarDailyMetrics {
  return {
    date: dailyActivity.date,
    steps: dailyActivity.active_steps,
    activeEnergyKcal: dailyActivity.active_calories,
    restingHr: nightlyRecharge?.heart_rate_avg,
    hrv: nightlyRecharge?.heart_rate_variability_avg,
    respiratoryRateAvg: nightlyRecharge?.breathing_rate_avg,
  };
}
