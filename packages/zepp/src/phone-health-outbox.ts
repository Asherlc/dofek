import {
  appendOutboxEntry,
  createEmptyOutbox,
  type DurableOutbox,
  type OutboxEntry,
} from "./durable-outbox.ts";
import type { HealthEnvelopeV1, ValidationIssue, ZeppConnectionType } from "./health-contract.ts";
import { type HealthUploadPayload, parseHealthUploadPayload } from "./health-upload.ts";
import { STORAGE_KEYS } from "./storage-keys.ts";

const PHONE_OUTBOX_VERSION = 1;

export interface PhoneHealthEvent {
  source: { connectionType: ZeppConnectionType; installId: string };
  payload: HealthUploadPayload;
}

export type PhoneHealthOutbox = DurableOutbox<PhoneHealthEvent>;

export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSource(value: unknown): PhoneHealthEvent["source"] {
  if (
    !isRecord(value) ||
    (value.connectionType !== "zepp" && value.connectionType !== "zepp-workout") ||
    typeof value.installId !== "string" ||
    !value.installId.trim()
  ) {
    throw new Error("Phone health outbox source is invalid.");
  }
  return { connectionType: value.connectionType, installId: value.installId };
}

function parsePhoneHealthEvent(value: unknown): PhoneHealthEvent {
  if (!isRecord(value)) {
    throw new Error("Phone health outbox event is invalid.");
  }
  return { source: parseSource(value.source), payload: parseHealthUploadPayload(value.payload) };
}

function parseEntry(value: unknown): OutboxEntry<PhoneHealthEvent> {
  if (
    !isRecord(value) ||
    typeof value.eventId !== "string" ||
    !value.eventId.trim() ||
    typeof value.createdAt !== "string" ||
    !value.createdAt.trim() ||
    !Number.isInteger(value.attempts) ||
    Number(value.attempts) < 0 ||
    (value.lastError !== undefined && typeof value.lastError !== "string")
  ) {
    throw new Error("Phone health outbox entry is invalid.");
  }
  return {
    eventId: value.eventId,
    createdAt: value.createdAt,
    payload: parsePhoneHealthEvent(value.payload),
    attempts: Number(value.attempts),
    ...(typeof value.lastError === "string" ? { lastError: value.lastError } : {}),
  };
}

function parseIssue(value: unknown): ValidationIssue {
  if (!isRecord(value) || typeof value.path !== "string" || typeof value.message !== "string") {
    throw new Error("Phone health outbox quarantine issue is invalid.");
  }
  return { path: value.path, message: value.message };
}

export function parsePhoneHealthOutbox(serialized: string): PhoneHealthOutbox {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error("Phone health outbox is not valid JSON.", { cause: error });
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== PHONE_OUTBOX_VERSION ||
    !Array.isArray(parsed.pending) ||
    !Array.isArray(parsed.quarantine)
  ) {
    throw new Error("Phone health outbox has an invalid shape.");
  }
  return {
    pending: parsed.pending.map(parseEntry),
    quarantine: parsed.quarantine.map((value) => {
      if (!isRecord(value) || !Array.isArray(value.issues)) {
        throw new Error("Phone health outbox quarantine entry is invalid.");
      }
      return { ...parseEntry(value), issues: value.issues.map(parseIssue) };
    }),
  };
}

export function serializePhoneHealthOutbox(outbox: PhoneHealthOutbox): string {
  return JSON.stringify({ version: PHONE_OUTBOX_VERSION, ...outbox });
}

export function readPhoneHealthOutbox(storage: SettingsStorage): PhoneHealthOutbox {
  const serialized = storage.getItem(STORAGE_KEYS.PHONE_HEALTH_OUTBOX);
  return serialized === null ? createEmptyOutbox() : parsePhoneHealthOutbox(serialized);
}

export function writePhoneHealthOutbox(storage: SettingsStorage, outbox: PhoneHealthOutbox): void {
  storage.setItem(STORAGE_KEYS.PHONE_HEALTH_OUTBOX, serializePhoneHealthOutbox(outbox));
}

export function persistHealthEnvelope(
  storage: SettingsStorage,
  envelope: HealthEnvelopeV1<HealthUploadPayload>,
): { acceptedEventIds: string[] } {
  let outbox = readPhoneHealthOutbox(storage);
  for (const event of envelope.events) {
    outbox = appendOutboxEntry(outbox, {
      eventId: event.eventId,
      createdAt: event.createdAt,
      payload: { source: envelope.source, payload: event.payload },
      attempts: 0,
    });
  }
  writePhoneHealthOutbox(storage, outbox);
  return { acceptedEventIds: envelope.events.map((event) => event.eventId) };
}
