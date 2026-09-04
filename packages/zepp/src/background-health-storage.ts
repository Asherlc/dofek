import { readFileSync, writeFileSync } from "@zos/fs";
import {
  appendBackgroundHealthEvents,
  type BackgroundHealthEvent,
  type BackgroundHealthOutbox,
  type BackgroundHealthSample,
} from "./background-health.ts";
import { createEmptyOutbox, type OutboxEntry } from "./durable-outbox.ts";
import type { HealthActivity, HealthDataPayload } from "./health-collector.ts";
import type { ValidationIssue } from "./health-contract.ts";
import { BACKGROUND_HEALTH_FILE } from "./storage-keys.ts";

const OUTBOX_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseSample(value: unknown): BackgroundHealthSample {
  if (!isRecord(value) || typeof value.recordedAt !== "string") {
    throw new Error("Background health sample is invalid.");
  }
  return {
    recordedAt: value.recordedAt,
    heartRate: optionalFiniteNumber(value.heartRate),
    bloodOxygenPercent: optionalFiniteNumber(value.bloodOxygenPercent),
    bodyTemperatureCelsius: optionalFiniteNumber(value.bodyTemperatureCelsius),
    stress: optionalFiniteNumber(value.stress),
  };
}

function parseActivity(value: unknown): HealthActivity {
  if (
    !isRecord(value) ||
    typeof value.externalId !== "string" ||
    value.activityType !== "other" ||
    typeof value.startedAt !== "string" ||
    typeof value.endedAt !== "string"
  ) {
    throw new Error("Background health activity is invalid.");
  }
  return {
    externalId: value.externalId,
    activityType: value.activityType,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
  };
}

function parseSummary(value: unknown): HealthDataPayload {
  if (
    !isRecord(value) ||
    typeof value.collectedAt !== "number" ||
    !Number.isFinite(value.collectedAt) ||
    typeof value.date !== "string" ||
    typeof value.timezoneOffsetMinutes !== "number" ||
    !Number.isFinite(value.timezoneOffsetMinutes) ||
    value.activities !== undefined
  ) {
    throw new Error("Watch health summary is invalid.");
  }
  return {
    ...value,
    collectedAt: value.collectedAt,
    date: value.date,
    timezoneOffsetMinutes: value.timezoneOffsetMinutes,
  };
}

function parseEvent(value: unknown): BackgroundHealthEvent {
  if (!isRecord(value)) {
    throw new Error("Background health event is invalid.");
  }
  if (value.kind === "sample") {
    return { kind: "sample", sample: parseSample(value.sample) };
  }
  if (value.kind === "activity") {
    return { kind: "activity", activity: parseActivity(value.activity) };
  }
  if (value.kind === "summary") {
    return { kind: "summary", summary: parseSummary(value.summary) };
  }
  throw new Error("Background health event is invalid.");
}

function parseEntry(value: unknown): OutboxEntry<BackgroundHealthEvent> {
  if (
    !isRecord(value) ||
    typeof value.eventId !== "string" ||
    !value.eventId.trim() ||
    typeof value.createdAt !== "string" ||
    !Number.isInteger(value.attempts) ||
    Number(value.attempts) < 0 ||
    (value.lastError !== undefined && typeof value.lastError !== "string")
  ) {
    throw new Error("Background health outbox entry is invalid.");
  }
  return {
    eventId: value.eventId,
    createdAt: value.createdAt,
    payload: parseEvent(value.payload),
    attempts: Number(value.attempts),
    ...(typeof value.lastError === "string" ? { lastError: value.lastError } : {}),
  };
}

function parseIssue(value: unknown): ValidationIssue {
  if (!isRecord(value) || typeof value.path !== "string" || typeof value.message !== "string") {
    throw new Error("Background health quarantine issue is invalid.");
  }
  return { path: value.path, message: value.message };
}

function parseCanonicalOutbox(parsed: Record<string, unknown>): BackgroundHealthOutbox {
  if (
    parsed.version !== OUTBOX_VERSION ||
    !Array.isArray(parsed.pending) ||
    !Array.isArray(parsed.quarantine)
  ) {
    throw new Error("Background health outbox has an invalid shape.");
  }
  return {
    pending: parsed.pending.map(parseEntry),
    quarantine: parsed.quarantine.map((value) => {
      if (!isRecord(value) || !Array.isArray(value.issues)) {
        throw new Error("Background health quarantine entry is invalid.");
      }
      return { ...parseEntry(value), issues: value.issues.map(parseIssue) };
    }),
  };
}

function migrateLegacyBuffer(
  parsed: Record<string, unknown>,
  installId: string,
): BackgroundHealthOutbox {
  if (!Array.isArray(parsed.samples) || !Array.isArray(parsed.activities)) {
    throw new Error("Background health outbox has an invalid shape.");
  }
  let outbox = createEmptyOutbox<BackgroundHealthEvent>();
  for (const sample of parsed.samples) {
    outbox = appendBackgroundHealthEvents(
      outbox,
      { sample: parseSample(sample), activities: [] },
      installId,
    );
  }
  if (parsed.activities.length > 0) {
    outbox = appendBackgroundHealthEvents(
      outbox,
      {
        activities: parsed.activities.map(parseActivity),
      },
      installId,
    );
  }
  return outbox;
}

export function parseBackgroundHealthOutbox(
  serialized: string,
  installId: string,
): BackgroundHealthOutbox {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error("Background health outbox is not valid JSON.", { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error("Background health outbox has an invalid shape.");
  }
  return "version" in parsed
    ? parseCanonicalOutbox(parsed)
    : migrateLegacyBuffer(parsed, installId);
}

export function serializeBackgroundHealthOutbox(outbox: BackgroundHealthOutbox): string {
  return JSON.stringify({ version: OUTBOX_VERSION, ...outbox });
}

export function readBackgroundHealthOutbox(installId: string): BackgroundHealthOutbox {
  let contents: ArrayBuffer | string;
  try {
    contents = readFileSync({
      path: BACKGROUND_HEALTH_FILE,
      options: { encoding: "utf8" },
    });
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return createEmptyOutbox();
    }
    throw error;
  }
  if (typeof contents !== "string") {
    return createEmptyOutbox();
  }
  return parseBackgroundHealthOutbox(contents, installId);
}

export function writeBackgroundHealthOutbox(outbox: BackgroundHealthOutbox): void {
  writeFileSync({ path: BACKGROUND_HEALTH_FILE, data: serializeBackgroundHealthOutbox(outbox) });
}
