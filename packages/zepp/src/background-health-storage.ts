import { readFileSync, renameSync, writeFileSync } from "@zos/fs";
import type {
  BackgroundHealthEvent,
  BackgroundHealthOutbox,
  BackgroundHealthSample,
} from "./background-health.ts";
import { createEmptyOutbox, type OutboxEntry } from "./durable-outbox.ts";
import type { HealthActivity, HealthDataPayload } from "./health-collector.ts";
import type { ValidationIssue } from "./health-contract.ts";
import { BACKGROUND_HEALTH_FILE } from "./storage-keys.ts";
import { parseWatchHealthSummary } from "./watch-health-summary-parser.ts";

const OUTBOX_VERSION = 1;
const CORRUPT_BACKGROUND_HEALTH_FILE = `${BACKGROUND_HEALTH_FILE}.corrupt`;

class CorruptBackgroundHealthOutboxError extends Error {
  readonly originalError: unknown;

  constructor(message: string, originalError?: unknown) {
    super(message);
    this.name = "CorruptBackgroundHealthOutboxError";
    this.originalError = originalError;
  }
}

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
  const summary = parseWatchHealthSummary(value);
  if (summary.activities !== undefined) {
    throw new Error("Watch health summary is invalid.");
  }
  return summary;
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
  const entries: Array<OutboxEntry<BackgroundHealthEvent>> = [
    ...parsed.samples.slice(-7 * 24 * 60).map((value) => {
      const sample = parseSample(value);
      return {
        eventId: `${installId}:background-sample:${sample.recordedAt}`,
        createdAt: sample.recordedAt,
        payload: { kind: "sample" as const, sample },
        attempts: 0,
      };
    }),
    ...parsed.activities.map((value) => {
      const activity = parseActivity(value);
      return {
        eventId: `${installId}:activity:${activity.externalId}:${activity.endedAt}`,
        createdAt: activity.endedAt,
        payload: { kind: "activity" as const, activity },
        attempts: 0,
      };
    }),
  ];
  return {
    pending: [...new Map(entries.map((entry) => [entry.eventId, entry])).values()],
    quarantine: [],
  };
}

export function parseBackgroundHealthOutbox(
  serialized: string,
  installId: string,
): BackgroundHealthOutbox {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("Background health outbox is not valid JSON.");
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
    throw new CorruptBackgroundHealthOutboxError(
      "Background health outbox storage returned non-text data.",
    );
  }
  try {
    return parseBackgroundHealthOutbox(contents, installId);
  } catch (error) {
    throw new CorruptBackgroundHealthOutboxError(
      "Background health outbox storage is corrupt.",
      error,
    );
  }
}

export function readBackgroundHealthOutboxForCollection(
  installId: string,
  onDiscard: (error: unknown) => void,
): BackgroundHealthOutbox {
  try {
    return readBackgroundHealthOutbox(installId);
  } catch (error) {
    if (!(error instanceof CorruptBackgroundHealthOutboxError)) throw error;
    const quarantineResult = renameSync({
      oldPath: BACKGROUND_HEALTH_FILE,
      newPath: CORRUPT_BACKGROUND_HEALTH_FILE,
    });
    if (quarantineResult !== 0) {
      throw new Error(`Could not quarantine corrupt background health data (${quarantineResult}).`);
    }
    onDiscard(error);
    return createEmptyOutbox();
  }
}

export function writeBackgroundHealthOutbox(outbox: BackgroundHealthOutbox): void {
  writeFileSync({ path: BACKGROUND_HEALTH_FILE, data: serializeBackgroundHealthOutbox(outbox) });
}
