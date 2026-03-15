import { mapGarminConnectSport } from "./sports.ts";
import type {
  GarminConnectActivity,
  GarminDailyUserSummary,
  GarminHrvData,
  GarminSleepData,
  GarminWeightEntry,
} from "./types.ts";

// ============================================================
// Parsed output types
// ============================================================

export interface ParsedActivity {
  externalId: string;
  activityType: string;
  name: string;
  startedAt: Date;
  endedAt: Date;
  distanceMeters?: number;
  averageHeartRate?: number;
  maxHeartRate?: number;
  averagePower?: number;
  maxPower?: number;
  normalizedPower?: number;
  calories?: number;
  elevationGain?: number;
  elevationLoss?: number;
  trainingStressScore?: number;
  aerobicTrainingEffect?: number;
  anaerobicTrainingEffect?: number;
  vo2Max?: number;
  raw: GarminConnectActivity;
}

export interface ParsedSleep {
  externalId: string;
  startedAt: Date;
  endedAt: Date;
  durationMinutes: number;
  deepMinutes: number;
  lightMinutes: number;
  remMinutes: number;
  awakeMinutes: number;
  sleepScore?: number;
  averageSpO2?: number;
  averageRespiration?: number;
}

export interface ParsedDailyMetrics {
  date: string;
  steps: number;
  distanceKm: number;
  activeEnergyKcal: number;
  basalEnergyKcal: number;
  restingHr?: number;
  maxHr?: number;
  averageStressLevel?: number;
  bodyBatteryCharged?: number;
  bodyBatteryDrained?: number;
  bodyBatteryHighest?: number;
  bodyBatteryLowest?: number;
  floorsAscended?: number;
  moderateIntensityMinutes?: number;
  vigorousIntensityMinutes?: number;
  spo2Avg?: number;
}

export interface ParsedWeight {
  externalId: string;
  recordedAt: Date;
  weightKg: number;
  bmi?: number;
  bodyFatPct?: number;
  muscleMassKg?: number;
  boneMassKg?: number;
  waterPct?: number;
  visceralFat?: number;
  metabolicAge?: number;
}

export interface ParsedHrv {
  date: string;
  weeklyAvg?: number;
  lastNight?: number;
  lastNightAvg?: number;
  lastNight5MinHigh?: number;
  status?: string;
}

// ============================================================
// Parsing functions
// ============================================================

/** Parse a Garmin Connect activity into our normalized format. */
export function parseGarminConnectActivity(raw: GarminConnectActivity): ParsedActivity {
  // Garmin GMT strings are "2024-01-15 12:30:00" — replace space with T and add Z to force UTC
  const gmtString = raw.startTimeGMT.replace(" ", "T") + "Z";
  const startedAt = new Date(gmtString);
  const endedAt = new Date(startedAt.getTime() + raw.duration * 1000);

  return {
    externalId: String(raw.activityId),
    activityType: mapGarminConnectSport(raw.activityType.typeKey),
    name: raw.activityName,
    startedAt,
    endedAt,
    distanceMeters: raw.distance,
    averageHeartRate: raw.averageHR,
    maxHeartRate: raw.maxHR,
    averagePower: raw.avgPower,
    maxPower: raw.maxPower,
    normalizedPower: raw.normPower,
    calories: raw.calories,
    elevationGain: raw.elevationGain,
    elevationLoss: raw.elevationLoss,
    trainingStressScore: raw.trainingStressScore,
    aerobicTrainingEffect: raw.aerobicTrainingEffect,
    anaerobicTrainingEffect: raw.anaerobicTrainingEffect,
    vo2Max: raw.vO2MaxValue,
    raw,
  };
}

/** Parse Garmin Connect sleep data into our normalized format. */
export function parseGarminConnectSleep(data: GarminSleepData): ParsedSleep {
  const dto = data.dailySleepDTO;
  return {
    externalId: dto.calendarDate,
    startedAt: new Date(dto.sleepStartTimestampGMT),
    endedAt: new Date(dto.sleepEndTimestampGMT),
    durationMinutes: Math.round(dto.sleepTimeSeconds / 60),
    deepMinutes: Math.round(dto.deepSleepSeconds / 60),
    lightMinutes: Math.round(dto.lightSleepSeconds / 60),
    remMinutes: Math.round(dto.remSleepSeconds / 60),
    awakeMinutes: Math.round(dto.awakeSleepSeconds / 60),
    sleepScore: dto.sleepScores?.overall?.value,
    averageSpO2: dto.averageSpO2Value,
    averageRespiration: dto.averageRespirationValue,
  };
}

/** Parse Garmin Connect daily summary into our normalized format. */
export function parseGarminConnectDailySummary(summary: GarminDailyUserSummary): ParsedDailyMetrics {
  return {
    date: summary.calendarDate,
    steps: summary.totalSteps,
    distanceKm: summary.totalDistanceMeters / 1000,
    activeEnergyKcal: summary.activeKilocalories,
    basalEnergyKcal: summary.bmrKilocalories,
    restingHr: summary.restingHeartRate,
    maxHr: summary.maxHeartRate,
    averageStressLevel: summary.averageStressLevel,
    bodyBatteryCharged: summary.bodyBatteryChargedValue,
    bodyBatteryDrained: summary.bodyBatteryDrainedValue,
    bodyBatteryHighest: summary.bodyBatteryHighestValue,
    bodyBatteryLowest: summary.bodyBatteryLowestValue,
    floorsAscended: summary.floorsAscended,
    moderateIntensityMinutes: summary.moderateIntensityMinutes,
    vigorousIntensityMinutes: summary.vigorousIntensityMinutes,
  };
}

/** Parse a Garmin weight entry. Weight is in grams in the API. */
export function parseGarminConnectWeight(entry: GarminWeightEntry): ParsedWeight {
  return {
    externalId: String(entry.samplePk),
    recordedAt: new Date(entry.date),
    weightKg: entry.weight / 1000,
    bmi: entry.bmi,
    bodyFatPct: entry.bodyFat,
    muscleMassKg: entry.muscleMass !== undefined ? entry.muscleMass / 1000 : undefined,
    boneMassKg: entry.boneMass !== undefined ? entry.boneMass / 1000 : undefined,
    waterPct: entry.bodyWater,
    visceralFat: entry.visceralFat,
    metabolicAge: entry.metabolicAge,
  };
}

/** Parse Garmin HRV data into our normalized format. */
export function parseGarminConnectHrv(data: GarminHrvData): ParsedHrv {
  return {
    date: data.calendarDate,
    weeklyAvg: data.hrvSummary?.weeklyAvg ?? data.weeklyAvg,
    lastNight: data.hrvSummary?.lastNight ?? data.lastNight,
    lastNightAvg: data.hrvSummary?.lastNightAvg ?? data.lastNightAvg,
    lastNight5MinHigh: data.hrvSummary?.lastNight5MinHigh ?? data.lastNight5MinHigh,
    status: data.hrvSummary?.status,
  };
}
