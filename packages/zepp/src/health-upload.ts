import type { BackgroundHealthSample } from "./background-health.ts";
import type { HealthActivity, HealthDataPayload } from "./health-collector.ts";
import { parseWatchHealthSummary } from "./watch-health-summary-parser.ts";
import { type LiveWorkoutSnapshot, SPORT_DATA_TYPES, type SportDataType } from "./workout-live.ts";

export interface HealthUploadPayload {
  watchSummary?: HealthDataPayload;
  activities?: HealthActivity[];
  backgroundSamples?: BackgroundHealthSample[];
  liveWorkoutSamples?: Array<LiveWorkoutSnapshot & { externalId: string }>;
}

function invalidPayload(): never {
  throw new Error("Health upload payload is invalid.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlankString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : invalidPayload();
}

function optionalFiniteNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : invalidPayload();
}

function parseActivity(value: unknown): HealthActivity {
  if (!isRecord(value) || value.activityType !== "other") invalidPayload();
  if (value.raw !== undefined && !isRecord(value.raw)) invalidPayload();
  return {
    externalId: nonBlankString(value.externalId),
    activityType: "other",
    startedAt: nonBlankString(value.startedAt),
    endedAt: nonBlankString(value.endedAt),
    ...(value.raw === undefined ? {} : { raw: value.raw }),
  };
}

function parseBackgroundSample(value: unknown): BackgroundHealthSample {
  if (!isRecord(value)) invalidPayload();
  const heartRate = optionalFiniteNumber(value.heartRate);
  const bloodOxygenPercent = optionalFiniteNumber(value.bloodOxygenPercent);
  const bodyTemperatureCelsius = optionalFiniteNumber(value.bodyTemperatureCelsius);
  const stress = optionalFiniteNumber(value.stress);
  return {
    recordedAt: nonBlankString(value.recordedAt),
    ...(heartRate === undefined ? {} : { heartRate }),
    ...(bloodOxygenPercent === undefined ? {} : { bloodOxygenPercent }),
    ...(bodyTemperatureCelsius === undefined ? {} : { bodyTemperatureCelsius }),
    ...(stress === undefined ? {} : { stress }),
  };
}

function parseLiveWorkoutSample(value: unknown): LiveWorkoutSnapshot & { externalId: string } {
  if (!isRecord(value) || !isRecord(value.metrics)) invalidPayload();
  const metrics: Partial<Record<SportDataType, number>> = {};
  for (const [key, metric] of Object.entries(value.metrics)) {
    if (!isSportDataType(key)) invalidPayload();
    metrics[key] = optionalFiniteNumber(metric) ?? invalidPayload();
  }
  const heartRate = optionalFiniteNumber(value.heartRate);
  return {
    externalId: nonBlankString(value.externalId),
    recordedAt: nonBlankString(value.recordedAt),
    ...(heartRate === undefined ? {} : { heartRate }),
    metrics,
  };
}

function isSportDataType(value: string): value is SportDataType {
  return SPORT_DATA_TYPES.some((candidate) => candidate === value);
}

function parseOptionalArray<T>(value: unknown, parseItem: (item: unknown) => T): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) invalidPayload();
  return value.map(parseItem);
}

export function parseHealthUploadPayload(value: unknown): HealthUploadPayload {
  if (!isRecord(value)) invalidPayload();

  let watchSummary: HealthDataPayload | undefined;
  if (value.watchSummary !== undefined) {
    try {
      watchSummary = parseWatchHealthSummary(value.watchSummary);
    } catch {
      invalidPayload();
    }
  }
  const activities = parseOptionalArray(value.activities, parseActivity);
  const backgroundSamples = parseOptionalArray(value.backgroundSamples, parseBackgroundSample);
  const liveWorkoutSamples = parseOptionalArray(value.liveWorkoutSamples, parseLiveWorkoutSample);
  if (
    watchSummary === undefined &&
    activities === undefined &&
    backgroundSamples === undefined &&
    liveWorkoutSamples === undefined
  ) {
    invalidPayload();
  }
  return {
    ...(watchSummary === undefined ? {} : { watchSummary }),
    ...(activities === undefined ? {} : { activities }),
    ...(backgroundSamples === undefined ? {} : { backgroundSamples }),
    ...(liveWorkoutSamples === undefined ? {} : { liveWorkoutSamples }),
  };
}
