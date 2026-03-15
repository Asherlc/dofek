import type { EightSleepSession, EightSleepTrendDay } from "./types.ts";

export interface ParsedEightSleepSession {
  externalId: string;
  startedAt: Date;
  endedAt: Date;
  durationMinutes: number;
  deepMinutes: number;
  remMinutes: number;
  lightMinutes: number;
  awakeMinutes: number;
  efficiencyPct: number;
  isNap: boolean;
}

export interface ParsedEightSleepDailyMetrics {
  date: string;
  restingHr?: number;
  hrv?: number;
  respiratoryRateAvg?: number;
  skinTempC?: number;
}

export interface ParsedEightSleepHrSample {
  recordedAt: Date;
  heartRate: number;
}

function secondsToMinutes(seconds: number): number {
  return Math.round(seconds / 60);
}

export function parseEightSleepTrendDay(day: EightSleepTrendDay): ParsedEightSleepSession {
  const totalSleepSeconds = day.sleepDuration;
  const totalInBedSeconds = day.presenceDuration;
  const efficiency =
    totalInBedSeconds > 0 ? Math.round((totalSleepSeconds / totalInBedSeconds) * 100) : 0;

  return {
    externalId: `eightsleep-${day.day}`,
    startedAt: new Date(day.presenceStart),
    endedAt: new Date(day.presenceEnd),
    durationMinutes: secondsToMinutes(totalSleepSeconds),
    deepMinutes: secondsToMinutes(day.deepDuration),
    remMinutes: secondsToMinutes(day.remDuration),
    lightMinutes: secondsToMinutes(day.lightDuration),
    awakeMinutes: secondsToMinutes(day.presenceDuration - day.sleepDuration),
    efficiencyPct: efficiency,
    isNap: false,
  };
}

export function parseEightSleepDailyMetrics(day: EightSleepTrendDay): ParsedEightSleepDailyMetrics {
  const quality = day.sleepQualityScore;
  return {
    date: day.day,
    restingHr: quality?.heartRate?.current,
    hrv: quality?.hrv?.current,
    respiratoryRateAvg: quality?.respiratoryRate?.current,
    skinTempC: quality?.tempBedC?.average,
  };
}

export function parseEightSleepHeartRateSamples(
  sessions: EightSleepSession[],
): ParsedEightSleepHrSample[] {
  const samples: ParsedEightSleepHrSample[] = [];
  for (const session of sessions) {
    const hrSeries = session.timeseries?.heartRate;
    if (!hrSeries) continue;
    for (const [timestamp, bpm] of hrSeries) {
      if (bpm > 0) {
        samples.push({ recordedAt: new Date(timestamp), heartRate: Math.round(bpm) });
      }
    }
  }
  return samples;
}
