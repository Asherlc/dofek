import {
  appendOutboxEntry,
  createEmptyOutbox,
  type DurableOutbox,
  type OutboxEntry,
} from "./durable-outbox.ts";
import type { HealthEnvelopeV1, ValidationIssue, ZeppConnectionType } from "./health-contract.ts";
import type { ImuChunkPayload } from "./imu-upload.ts";
import { parseImuEnvelope } from "./imu-upload.ts";
import type { SettingsStorage } from "./phone-health-outbox.ts";
import { STORAGE_KEYS } from "./storage-keys.ts";

const VERSION = 1;

export interface PhoneImuEvent {
  source: { connectionType: ZeppConnectionType; installId: string };
  payload: ImuChunkPayload;
}

export type PhoneImuOutbox = DurableOutbox<PhoneImuEvent>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntry(value: unknown): OutboxEntry<PhoneImuEvent> {
  if (
    !isRecord(value) ||
    typeof value.eventId !== "string" ||
    typeof value.createdAt !== "string" ||
    !Number.isInteger(value.attempts) ||
    Number(value.attempts) < 0 ||
    !isRecord(value.payload)
  ) {
    throw new Error("Phone IMU outbox is invalid.");
  }
  const envelope = parseImuEnvelope({
    version: 1,
    batchId: value.eventId,
    source: value.payload.source,
    events: [
      { eventId: value.eventId, createdAt: value.createdAt, payload: value.payload.payload },
    ],
  });
  const event = envelope.events[0];
  if (!event) throw new Error("Phone IMU outbox is invalid.");
  return {
    eventId: event.eventId,
    createdAt: event.createdAt,
    payload: { source: envelope.source, payload: event.payload },
    attempts: Number(value.attempts),
    ...(typeof value.lastError === "string" ? { lastError: value.lastError } : {}),
  };
}

function parseIssue(value: unknown): ValidationIssue {
  if (!isRecord(value) || typeof value.path !== "string" || typeof value.message !== "string") {
    throw new Error("Phone IMU outbox is invalid.");
  }
  return { path: value.path, message: value.message };
}

export function readPhoneImuOutbox(storage: SettingsStorage): PhoneImuOutbox {
  const serialized = storage.getItem(STORAGE_KEYS.PHONE_IMU_OUTBOX);
  if (!serialized) return createEmptyOutbox();
  const parsed: unknown = JSON.parse(serialized);
  if (
    !isRecord(parsed) ||
    parsed.version !== VERSION ||
    !Array.isArray(parsed.pending) ||
    !Array.isArray(parsed.quarantine)
  ) {
    throw new Error("Phone IMU outbox is invalid.");
  }
  return {
    pending: parsed.pending.map(parseEntry),
    quarantine: parsed.quarantine.map((value) => {
      if (!isRecord(value) || !Array.isArray(value.issues)) {
        throw new Error("Phone IMU outbox is invalid.");
      }
      return { ...parseEntry(value), issues: value.issues.map(parseIssue) };
    }),
  };
}

export function writePhoneImuOutbox(storage: SettingsStorage, outbox: PhoneImuOutbox): void {
  storage.setItem(STORAGE_KEYS.PHONE_IMU_OUTBOX, JSON.stringify({ version: VERSION, ...outbox }));
}

export function persistImuEnvelope(
  storage: SettingsStorage,
  envelope: HealthEnvelopeV1<ImuChunkPayload>,
): { acceptedEventIds: string[] } {
  let outbox = readPhoneImuOutbox(storage);
  for (const event of envelope.events) {
    outbox = appendOutboxEntry(outbox, {
      eventId: event.eventId,
      createdAt: event.createdAt,
      payload: { source: envelope.source, payload: event.payload },
      attempts: 0,
    });
  }
  writePhoneImuOutbox(storage, outbox);
  return { acceptedEventIds: envelope.events.map((event) => event.eventId) };
}
