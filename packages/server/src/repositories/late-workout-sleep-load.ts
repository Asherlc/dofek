import type { LateWorkoutSleepNight } from "@dofek/training/late-workout-sleep";

type HeartRateSeconds = readonly [bpm: number, seconds: number];

type WorkoutRecording = {
  date: string;
  /** Seconds per BPM from a complete, verified recording, or null if verification failed. */
  samples: readonly HeartRateSeconds[] | null;
};

type HeartRateProfile = {
  maxHeartRate: number | null;
  birthDate: string | null;
};

type HeartRateMaximum =
  | { bpm: number; basis: "profile"; date: string }
  | { bpm: number; basis: "age_estimate"; age: number; date: string };

function maximumForDate(date: string, profile: HeartRateProfile): HeartRateMaximum | null {
  const { maxHeartRate, birthDate } = profile;
  if (maxHeartRate !== null && Number.isFinite(maxHeartRate) && maxHeartRate > 0) {
    return { bpm: maxHeartRate, basis: "profile", date };
  }
  if (birthDate === null || birthDate > date) return null;
  const age =
    Number(date.slice(0, 4)) -
    Number(birthDate.slice(0, 4)) -
    Number(date.slice(5) < birthDate.slice(5));
  const bpm = 192 - 0.007 * age ** 2;
  return Number.isFinite(bpm) && bpm > 0 ? { bpm, basis: "age_estimate", age, date } : null;
}

function loadCategory(score: number): NonNullable<LateWorkoutSleepNight["load"]["category"]> {
  if (score < 116) return "light";
  if (score < 214) return "moderate";
  if (score <= 461) return "high";
  return "maximal";
}

export function scoreLateWorkoutSleepLoad(
  recordings: readonly WorkoutRecording[],
  profile: HeartRateProfile,
) {
  const maximums: HeartRateMaximum[] = [];
  const unavailable = { score: null, category: null, coveredSeconds: null, maximums };
  let coveredSeconds = 0;
  for (const { samples } of recordings) {
    if (!samples || samples.length === 0) {
      return {
        ...unavailable,
        reason: "Every workout in the bout needs a complete heart-rate recording.",
      };
    }
    for (const [bpm, seconds] of samples) {
      if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isSafeInteger(seconds) || seconds <= 0) {
        return { ...unavailable, reason: "The verified heart-rate recording has invalid values." };
      }
      coveredSeconds += seconds;
    }
  }
  if (coveredSeconds === 0) {
    return { ...unavailable, reason: "No complete heart-rate recording is available." };
  }

  let weightedSeconds = 0;
  let aboveMaximum = false;
  for (const { date, samples } of recordings) {
    const maximum = maximumForDate(date, profile);
    if (!maximum) {
      return {
        ...unavailable,
        coveredSeconds,
        reason: "A personal maximum heart rate or birth date is required.",
      };
    }
    maximums.push(maximum);
    for (const [bpm, seconds] of samples ?? []) {
      if (bpm > maximum.bpm) aboveMaximum = true;
      const weight = [50, 60, 70, 80, 90].filter(
        (threshold) => bpm * 100 >= maximum.bpm * threshold,
      ).length;
      weightedSeconds += weight * seconds;
    }
  }
  if (aboveMaximum) {
    return {
      ...unavailable,
      coveredSeconds,
      reason: "Recorded heart rate exceeds the selected maximum.",
    };
  }
  const score = weightedSeconds / 60;
  return { score, category: loadCategory(score), coveredSeconds, maximums, reason: null };
}
