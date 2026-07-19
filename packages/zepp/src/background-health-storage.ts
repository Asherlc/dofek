import { readFileSync, writeFileSync } from "@zos/fs";
import {
  type BackgroundHealthBuffer,
  type BackgroundHealthSample,
  emptyBackgroundHealthBuffer,
} from "./background-health.ts";
import type { HealthActivity } from "./health-collector.ts";
import { BACKGROUND_HEALTH_FILE } from "./storage-keys.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function parseSample(value: unknown): BackgroundHealthSample | undefined {
  if (!isRecord(value) || typeof value.recordedAt !== "string") return undefined;
  return {
    recordedAt: value.recordedAt,
    heartRate: optionalNumber(value.heartRate),
    bloodOxygenPercent: optionalNumber(value.bloodOxygenPercent),
    bodyTemperatureCelsius: optionalNumber(value.bodyTemperatureCelsius),
    stress: optionalNumber(value.stress),
  };
}

function parseActivity(value: unknown): HealthActivity | undefined {
  if (
    !isRecord(value) ||
    typeof value.externalId !== "string" ||
    value.activityType !== "other" ||
    typeof value.startedAt !== "string" ||
    typeof value.endedAt !== "string"
  ) {
    return undefined;
  }
  return {
    externalId: value.externalId,
    activityType: value.activityType,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
  };
}

export function parseBackgroundHealthBuffer(serialized: string): BackgroundHealthBuffer {
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed) || !Array.isArray(parsed.samples) || !Array.isArray(parsed.activities)) {
      return emptyBackgroundHealthBuffer();
    }
    return {
      samples: parsed.samples.flatMap((value) => {
        const sample = parseSample(value);
        return sample ? [sample] : [];
      }),
      activities: parsed.activities.flatMap((value) => {
        const activity = parseActivity(value);
        return activity ? [activity] : [];
      }),
    };
  } catch {
    return emptyBackgroundHealthBuffer();
  }
}

export function readBackgroundHealthBuffer(): BackgroundHealthBuffer {
  try {
    const contents = readFileSync({
      path: BACKGROUND_HEALTH_FILE,
      options: { encoding: "utf8" },
    });
    return typeof contents === "string"
      ? parseBackgroundHealthBuffer(contents)
      : emptyBackgroundHealthBuffer();
  } catch {
    return emptyBackgroundHealthBuffer();
  }
}

export function writeBackgroundHealthBuffer(buffer: BackgroundHealthBuffer): void {
  writeFileSync({ path: BACKGROUND_HEALTH_FILE, data: JSON.stringify(buffer) });
}

function samplesMatch(left: BackgroundHealthSample, right: BackgroundHealthSample): boolean {
  return (
    left.recordedAt === right.recordedAt &&
    left.heartRate === right.heartRate &&
    left.bloodOxygenPercent === right.bloodOxygenPercent &&
    left.bodyTemperatureCelsius === right.bodyTemperatureCelsius &&
    left.stress === right.stress
  );
}

function activitiesMatch(left: HealthActivity, right: HealthActivity): boolean {
  return (
    left.externalId === right.externalId &&
    left.activityType === right.activityType &&
    left.startedAt === right.startedAt &&
    left.endedAt === right.endedAt
  );
}

export function removeUploadedBackgroundHealthBufferEntries(
  current: BackgroundHealthBuffer,
  uploaded: BackgroundHealthBuffer,
): BackgroundHealthBuffer {
  return {
    samples: current.samples.filter(
      (sample) => !uploaded.samples.some((uploadedSample) => samplesMatch(sample, uploadedSample)),
    ),
    activities: current.activities.filter(
      (activity) =>
        !uploaded.activities.some((uploadedActivity) =>
          activitiesMatch(activity, uploadedActivity),
        ),
    ),
  };
}
