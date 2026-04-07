import {
  type CanonicalActivityType,
  createActivityTypeMapper,
  OURA_ACTIVITY_TYPE_MAP,
} from "@dofek/training/training";
import type {
  OuraDailyActivity,
  OuraDailyReadiness,
  OuraDailyResilience,
  OuraDailySpO2,
  OuraDailyStress,
  OuraSleepDocument,
  OuraVO2Max,
} from "./schemas.ts";

export interface ParsedOuraSleep {
  externalId: string;
  startedAt: Date;
  endedAt: Date;
  durationMinutes?: number;
  deepMinutes?: number;
  remMinutes?: number;
  lightMinutes?: number;
  awakeMinutes?: number;
  efficiencyPct: number;
  sleepType: OuraSleepDocument["type"];
  isNap: boolean;
}

export interface ParsedOuraDailyMetrics {
  date: string;
  steps?: number;
  activeEnergyKcal?: number;
  hrv?: number;
  restingHr?: number;
  exerciseMinutes?: number;
  skinTempC?: number;
  spo2Avg?: number;
  vo2max?: number;
  stressHighMinutes?: number;
  recoveryHighMinutes?: number;
  resilienceLevel?: string;
}

function secondsToMinutes(seconds: number | null): number | undefined {
  if (seconds === null) return undefined;
  return Math.round(seconds / 60);
}

export function parseOuraSleep(sleep: OuraSleepDocument): ParsedOuraSleep {
  return {
    externalId: sleep.id,
    startedAt: new Date(sleep.bedtime_start),
    endedAt: new Date(sleep.bedtime_end),
    durationMinutes: secondsToMinutes(sleep.total_sleep_duration),
    deepMinutes: secondsToMinutes(sleep.deep_sleep_duration),
    remMinutes: secondsToMinutes(sleep.rem_sleep_duration),
    lightMinutes: secondsToMinutes(sleep.light_sleep_duration),
    awakeMinutes: secondsToMinutes(sleep.awake_time),
    efficiencyPct: sleep.efficiency,
    sleepType: sleep.type,
    isNap: sleep.type !== "long_sleep" && sleep.type !== "sleep",
  };
}

export function parseOuraDailyMetrics(
  readiness: OuraDailyReadiness | null,
  activity: OuraDailyActivity | null,
  spo2: OuraDailySpO2 | null,
  vo2max: OuraVO2Max | null,
  stress: OuraDailyStress | null,
  resilience: OuraDailyResilience | null,
  sleep: OuraSleepDocument | null,
): ParsedOuraDailyMetrics {
  const day =
    readiness?.day ??
    activity?.day ??
    spo2?.day ??
    vo2max?.day ??
    stress?.day ??
    resilience?.day ??
    "";

  let exerciseMinutes: number | undefined;
  if (activity) {
    exerciseMinutes = Math.round(
      (activity.high_activity_time + activity.medium_activity_time) / 60,
    );
  }

  return {
    date: day,
    steps: activity?.steps,
    activeEnergyKcal: activity?.active_calories,
    // HRV and resting HR come from the actual sleep measurements, not from
    // readiness contributor scores. contributors.hrv_balance is a 0-100 score
    // indicating how HRV contributes to readiness — not the HRV value itself.
    hrv: sleep?.average_hrv ?? undefined,
    restingHr: sleep?.lowest_heart_rate ?? undefined,
    exerciseMinutes,
    skinTempC: readiness?.temperature_deviation ?? undefined,
    spo2Avg: spo2?.spo2_percentage?.average ?? undefined,
    vo2max: vo2max?.vo2_max ?? undefined,
    stressHighMinutes: secondsToMinutes(stress?.stress_high ?? null),
    recoveryHighMinutes: secondsToMinutes(stress?.recovery_high ?? null),
    resilienceLevel: resilience?.level ?? undefined,
  };
}

const mapOuraType = createActivityTypeMapper(OURA_ACTIVITY_TYPE_MAP);

export function mapOuraActivityType(ouraActivity: string): CanonicalActivityType {
  const key = ouraActivity.toLowerCase();
  return mapOuraType(key);
}

const OURA_SESSION_TYPE_MAP: Record<string, CanonicalActivityType> = {
  meditation: "meditation",
  breathing: "breathwork",
  nap: "other",
  relaxation: "other",
  rest: "other",
  body_status: "other",
};

export function mapOuraSessionType(sessionType: string): CanonicalActivityType {
  return OURA_SESSION_TYPE_MAP[sessionType] ?? "other";
}
