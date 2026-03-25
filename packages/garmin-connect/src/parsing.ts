import type { CanonicalActivityType } from "@dofek/training/training";
import type {
  ConnectActivityDetail,
  ConnectActivitySummary,
  ConnectDailySummary,
  ConnectSleepData,
  DailyHeartRate,
  DailyStress,
  HrvSummary,
  TrainingReadiness,
  TrainingStatus,
} from "./types.ts";

// ============================================================
// Activity type mapping (internal typeKey → normalized)
// ============================================================

const GARMIN_ACTIVITY_TYPE_MAP: Record<string, CanonicalActivityType> = {
  running: "running",
  trail_running: "running",
  treadmill_running: "running",
  track_running: "running",
  cycling: "cycling",
  mountain_biking: "mountain_biking",
  road_biking: "road_cycling",
  indoor_cycling: "indoor_cycling",
  gravel_cycling: "gravel_cycling",
  virtual_ride: "virtual_cycling",
  swimming: "swimming",
  lap_swimming: "swimming",
  open_water_swimming: "swimming",
  walking: "walking",
  hiking: "hiking",
  strength_training: "strength",
  indoor_cardio: "cardio",
  yoga: "yoga",
  pilates: "pilates",
  elliptical: "elliptical",
  indoor_rowing: "rowing",
  rowing: "rowing",
  multi_sport: "multisport",
  triathlon: "multisport",
  cross_country_skiing: "skiing",
  resort_skiing_snowboarding_ws: "skiing",
  skate_skiing_ws: "skiing",
  backcountry_skiing: "skiing",
  snowboarding_ws: "skiing",
  rock_climbing: "climbing",
  bouldering: "climbing",
  transition: "transition",
  breathwork: "breathwork",
  meditation: "meditation",
};

export function mapConnectActivityType(typeKey: string): CanonicalActivityType {
  return GARMIN_ACTIVITY_TYPE_MAP[typeKey] ?? "other";
}

// ============================================================
// Parsed output types
// ============================================================

export interface ParsedConnectActivity {
  externalId: string;
  activityType: CanonicalActivityType;
  name: string;
  startedAt: Date;
  endedAt: Date;
  raw: ConnectActivitySummary;
}

export interface ParsedConnectSleep {
  externalId: string;
  startedAt: Date;
  endedAt: Date;
  durationMinutes: number;
  deepMinutes: number;
  lightMinutes: number;
  remMinutes: number;
  awakeMinutes: number;
  sleepScore: number | undefined;
  awakeningCount: number | undefined;
  averageSpO2: number | undefined;
  averageRespiration: number | undefined;
}

export interface ParsedDailyMetrics {
  date: string;
  steps: number;
  distanceKm: number;
  activeEnergyKcal: number;
  basalEnergyKcal: number;
  restingHr: number | undefined;
  spo2Avg: number | undefined;
  respiratoryRateAvg: number | undefined;
  flightsClimbed: number | undefined;
  exerciseMinutes: number | undefined;
}

export interface ParsedTrainingStatus {
  date: string;
  acuteTrainingLoad: number | undefined;
  chronicTrainingLoad: number | undefined;
  trainingLoadBalance: number | undefined;
  trainingLoadRatio: number | undefined;
  vo2MaxRunning: number | undefined;
  vo2MaxCycling: number | undefined;
  fitnessAge: number | undefined;
  statusMessage: string | undefined;
}

export interface ParsedTrainingReadiness {
  date: string;
  score: number | undefined;
  level: string | undefined;
  sleepScore: number | undefined;
  recoveryScore: number | undefined;
  acuteTrainingLoadScore: number | undefined;
  hrvScore: number | undefined;
}

export interface ParsedHrvSummary {
  date: string;
  weeklyAvg: number | undefined;
  lastNight: number | undefined;
  lastNightAvg: number | undefined;
  lastNight5MinHigh: number | undefined;
  status: string | undefined;
  baselineLow: number | undefined;
  baselineBalancedLow: number | undefined;
  baselineBalancedUpper: number | undefined;
}

export interface ParsedStressTimeSeries {
  date: string;
  avgStressLevel: number;
  maxStressLevel: number;
  samples: Array<{ timestamp: Date; stressLevel: number }>;
}

export interface ParsedHeartRateTimeSeries {
  date: string;
  restingHeartRate: number;
  minHeartRate: number;
  maxHeartRate: number;
  samples: Array<{ timestamp: Date; heartRate: number }>;
}

export interface ParsedActivityStream {
  activityId: number;
  metricKeys: string[];
  samples: Array<Record<string, number | null>>;
}

// ============================================================
// Helpers
// ============================================================

function ensureUtcSuffix(dateString: string): string {
  return dateString.endsWith("Z") ? dateString : `${dateString}Z`;
}

// ============================================================
// Parsing functions
// ============================================================

export function parseConnectActivity(raw: ConnectActivitySummary): ParsedConnectActivity {
  // Garmin labels times as "GMT" but doesn't include a Z suffix,
  // so new Date() would parse them as local time. Append Z to force UTC.
  const startedAt = new Date(ensureUtcSuffix(raw.startTimeGMT));
  // duration is in milliseconds from the internal API
  const durationMs = raw.duration;
  const endedAt = new Date(startedAt.getTime() + durationMs);

  return {
    externalId: String(raw.activityId),
    activityType: mapConnectActivityType(raw.activityType.typeKey),
    name: raw.activityName,
    startedAt,
    endedAt,
    raw,
  };
}

export function parseConnectSleep(data: ConnectSleepData): ParsedConnectSleep | null {
  const dto = data.dailySleepDTO;
  if (!dto.sleepStartTimestampGMT || !dto.sleepEndTimestampGMT) {
    return null;
  }

  return {
    externalId: String(dto.id),
    startedAt: new Date(dto.sleepStartTimestampGMT),
    endedAt: new Date(dto.sleepEndTimestampGMT),
    durationMinutes: Math.round((dto.sleepTimeSeconds ?? 0) / 60),
    deepMinutes: Math.round((dto.deepSleepSeconds ?? 0) / 60),
    lightMinutes: Math.round((dto.lightSleepSeconds ?? 0) / 60),
    remMinutes: Math.round((dto.remSleepSeconds ?? 0) / 60),
    awakeMinutes: Math.round((dto.awakeSleepSeconds ?? 0) / 60),
    sleepScore: dto.sleepScores?.overall?.value,
    awakeningCount: dto.awakeningCount,
    averageSpO2: dto.averageSpO2Value,
    averageRespiration: dto.averageRespirationValue,
  };
}

export function parseConnectDailySummary(summary: ConnectDailySummary): ParsedDailyMetrics {
  const moderateMin = summary.moderateIntensityMinutes;
  const vigorousMin = summary.vigorousIntensityMinutes;
  let exerciseMinutes: number | undefined;
  if (moderateMin !== undefined || vigorousMin !== undefined) {
    exerciseMinutes = (moderateMin ?? 0) + (vigorousMin ?? 0);
  }

  return {
    date: summary.calendarDate,
    steps: summary.totalSteps,
    distanceKm: summary.totalDistanceMeters / 1000,
    activeEnergyKcal: summary.activeKilocalories,
    basalEnergyKcal: summary.bmrKilocalories,
    restingHr: summary.restingHeartRate,
    spo2Avg: summary.averageSpo2,
    respiratoryRateAvg: undefined, // not in daily summary, use respiration endpoint
    flightsClimbed: summary.floorsAscended,
    exerciseMinutes,
  };
}

export function parseTrainingStatus(status: TrainingStatus, date: string): ParsedTrainingStatus {
  return {
    date,
    acuteTrainingLoad: status.acuteTrainingLoad,
    chronicTrainingLoad: status.chronicTrainingLoad,
    trainingLoadBalance: status.trainingLoadBalance,
    trainingLoadRatio: status.trainingLoadRatio,
    vo2MaxRunning: status.latestRunVo2Max ?? status.latestVo2Max,
    vo2MaxCycling: status.latestCycleVo2Max ?? status.latestVo2MaxCycling,
    fitnessAge: status.latestFitnessAge ?? status.fitnessAge,
    statusMessage: status.trainingStatusMessage,
  };
}

export function parseTrainingReadiness(readiness: TrainingReadiness): ParsedTrainingReadiness {
  return {
    date: readiness.calendarDate,
    score: readiness.score,
    level: readiness.level,
    sleepScore: readiness.sleepScore,
    recoveryScore: readiness.recoveryScore,
    acuteTrainingLoadScore: readiness.acuteTrainingLoadScore,
    hrvScore: readiness.hrvScore,
  };
}

export function parseHrvSummary(hrv: HrvSummary): ParsedHrvSummary {
  return {
    date: hrv.calendarDate,
    weeklyAvg: hrv.weeklyAvg,
    lastNight: hrv.lastNight,
    lastNightAvg: hrv.lastNightAvg,
    lastNight5MinHigh: hrv.lastNight5MinHigh,
    status: hrv.status,
    baselineLow: hrv.baseline?.lowUpper,
    baselineBalancedLow: hrv.baseline?.balancedLow,
    baselineBalancedUpper: hrv.baseline?.balancedUpper,
  };
}

export function parseStressTimeSeries(stress: DailyStress): ParsedStressTimeSeries {
  const samples: Array<{ timestamp: Date; stressLevel: number }> = [];

  if (stress.stressValuesArray) {
    for (const [timestampMs, level] of stress.stressValuesArray) {
      // Garmin uses -1, -2, -3 for non-stress states (rest, activity, uncategorized)
      if (level !== undefined && level >= 0) {
        samples.push({
          timestamp: new Date(timestampMs ?? 0),
          stressLevel: level,
        });
      }
    }
  }

  return {
    date: stress.calendarDate,
    avgStressLevel: stress.avgStressLevel,
    maxStressLevel: stress.maxStressLevel,
    samples,
  };
}

export function parseHeartRateTimeSeries(hr: DailyHeartRate): ParsedHeartRateTimeSeries {
  const samples: Array<{ timestamp: Date; heartRate: number }> = [];

  if (hr.heartRateValues) {
    for (const [timestampMs, value] of hr.heartRateValues) {
      if (timestampMs !== null && value !== null && value > 0) {
        samples.push({
          timestamp: new Date(timestampMs),
          heartRate: value,
        });
      }
    }
  }

  return {
    date: hr.calendarDate,
    restingHeartRate: hr.restingHeartRate,
    minHeartRate: hr.minHeartRate,
    maxHeartRate: hr.maxHeartRate,
    samples,
  };
}

export function parseActivityDetail(detail: ConnectActivityDetail): ParsedActivityStream {
  const metricKeys = detail.metricDescriptors.map((d) => d.key);

  const samples: Array<Record<string, number | null>> = [];
  for (const metric of detail.activityDetailMetrics) {
    const sample: Record<string, number | null> = {};
    for (let i = 0; i < metricKeys.length; i++) {
      const key = metricKeys[i];
      if (key) {
        sample[key] = metric.metrics[i] ?? null;
      }
    }
    samples.push(sample);
  }

  return {
    activityId: detail.activityId,
    metricKeys,
    samples,
  };
}
