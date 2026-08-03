import {
  type RecordLocalTimeContext,
  resolveTimestampOffsetLocalTimeContext,
} from "@dofek/format/record-local-time";
import {
  type LegacyActivityType,
  type ProviderActivityType,
  resolveProviderActivityType,
} from "@dofek/training/activity-types";
import { createActivityTypeMapper, OURA_ACTIVITY_TYPE_MAP } from "@dofek/training/training";
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
  stagingAvailable: boolean;
  efficiencyPct: number;
  sleepType: OuraSleepDocument["type"];
  isNap: boolean;
  localTimeContext: RecordLocalTimeContext;
}

export interface ParsedOuraDailyMetrics {
  date: string;
  steps?: number;
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

export function parseOuraRecordLocalTimeContext(startTimestamp: string, endTimestamp: string) {
  return resolveTimestampOffsetLocalTimeContext({
    startedAtTimestamp: startTimestamp,
    endedAtTimestamp: endTimestamp,
    source: "provider_offset",
  });
}

export function ouraProviderOffsetColumns(startTimestamp: string, endTimestamp: string) {
  const context = parseOuraRecordLocalTimeContext(startTimestamp, endTimestamp);
  return {
    timezone: context.timezone,
    startUtcOffsetMinutes: context.startUtcOffsetMinutes,
    endUtcOffsetMinutes: context.endUtcOffsetMinutes,
    localTimeSource: context.source,
  };
}

function secondsToMinutes(seconds: number | null): number | undefined {
  if (seconds === null) return undefined;
  return Math.round(seconds / 60);
}

export function parseOuraSleep(sleep: OuraSleepDocument): ParsedOuraSleep {
  const stagingAvailable =
    sleep.deep_sleep_duration != null &&
    sleep.rem_sleep_duration != null &&
    sleep.light_sleep_duration != null &&
    sleep.awake_time != null;
  const startedAt = new Date(sleep.bedtime_start);
  const endedAt = new Date(sleep.bedtime_end);
  const localTimeContext = parseOuraRecordLocalTimeContext(sleep.bedtime_start, sleep.bedtime_end);
  return {
    externalId: sleep.id,
    startedAt,
    endedAt,
    durationMinutes: secondsToMinutes(sleep.total_sleep_duration),
    deepMinutes: secondsToMinutes(sleep.deep_sleep_duration),
    remMinutes: secondsToMinutes(sleep.rem_sleep_duration),
    lightMinutes: secondsToMinutes(sleep.light_sleep_duration),
    awakeMinutes: secondsToMinutes(sleep.awake_time),
    stagingAvailable,
    efficiencyPct: sleep.efficiency,
    sleepType: sleep.type,
    isNap: sleep.type !== "long_sleep" && sleep.type !== "sleep",
    localTimeContext,
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

export function mapOuraActivityType(ouraActivity: string): ProviderActivityType {
  const key = ouraActivity.toLowerCase();
  const normalized = mapOuraType(key);
  return { ...normalized, providerType: ouraActivity };
}

const OURA_SESSION_TYPE_MAP: Record<string, LegacyActivityType> = {
  meditation: "meditation",
  breathing: "breathwork",
  nap: "other",
  relaxation: "other",
  rest: "other",
  body_status: "other",
};

export function mapOuraSessionType(sessionType: string): ProviderActivityType {
  return resolveProviderActivityType(sessionType, OURA_SESSION_TYPE_MAP[sessionType] ?? "other");
}
