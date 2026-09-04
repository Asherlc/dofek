import { createEmptyOutbox, type DurableOutbox, type OutboxEntry } from "./durable-outbox.ts";
import type { HealthEnvelopeV1, ValidationIssue, ZeppConnectionType } from "./health-contract.ts";
import type { ImuChunkPayload } from "./imu-upload.ts";
import { parseImuEnvelope } from "./imu-upload.ts";
import type { SettingsStorage } from "./phone-health-outbox.ts";
import { STORAGE_KEYS } from "./storage-keys.ts";

const VERSION = 2;
const LEGACY_VERSION = 1;
const MAX_PENDING_BATCH_SCAN = 100;

type QueueName = "pending" | "quarantine";

interface PhoneImuOutboxIndex {
  pending: string[];
  quarantine: string[];
}

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

function parseIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error("Phone IMU outbox index is invalid.");
  }
  return value.map(String);
}

function entryKey(queue: QueueName, eventId: string): string {
  return `${STORAGE_KEYS.PHONE_IMU_OUTBOX}:${queue}:${encodeURIComponent(eventId)}`;
}

function serializeEntry(entry: OutboxEntry<PhoneImuEvent>): string {
  return JSON.stringify(entry);
}

function serializeQuarantineEntry(entry: PhoneImuOutbox["quarantine"][number]): string {
  return JSON.stringify(entry);
}

function readStoredEntry(
  storage: SettingsStorage,
  queue: "pending",
  eventId: string,
): OutboxEntry<PhoneImuEvent>;
function readStoredEntry(
  storage: SettingsStorage,
  queue: "quarantine",
  eventId: string,
): PhoneImuOutbox["quarantine"][number];
function readStoredEntry(storage: SettingsStorage, queue: QueueName, eventId: string) {
  const serialized = storage.getItem(entryKey(queue, eventId));
  if (!serialized) throw new Error(`Phone IMU ${queue} entry is missing.`);
  const parsed: unknown = JSON.parse(serialized);
  if (queue === "pending") return parseEntry(parsed);
  if (!isRecord(parsed) || !Array.isArray(parsed.issues)) {
    throw new Error("Phone IMU outbox is invalid.");
  }
  return { ...parseEntry(parsed), issues: parsed.issues.map(parseIssue) };
}

function parseLegacyOutbox(parsed: Record<string, unknown>): PhoneImuOutbox {
  if (!Array.isArray(parsed.pending) || !Array.isArray(parsed.quarantine)) {
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

function persistIndex(storage: SettingsStorage, index: PhoneImuOutboxIndex): void {
  storage.setItem(STORAGE_KEYS.PHONE_IMU_OUTBOX, JSON.stringify({ version: VERSION, ...index }));
}

function persistShardedOutbox(storage: SettingsStorage, outbox: PhoneImuOutbox): void {
  for (const entry of outbox.pending) {
    storage.setItem(entryKey("pending", entry.eventId), serializeEntry(entry));
  }
  for (const entry of outbox.quarantine) {
    storage.setItem(entryKey("quarantine", entry.eventId), serializeQuarantineEntry(entry));
  }
  persistIndex(storage, {
    pending: outbox.pending.map((entry) => entry.eventId),
    quarantine: outbox.quarantine.map((entry) => entry.eventId),
  });
}

function readIndex(storage: SettingsStorage): PhoneImuOutboxIndex {
  const serialized = storage.getItem(STORAGE_KEYS.PHONE_IMU_OUTBOX);
  if (!serialized) return { pending: [], quarantine: [] };
  const parsed: unknown = JSON.parse(serialized);
  if (!isRecord(parsed)) throw new Error("Phone IMU outbox is invalid.");
  if (parsed.version === LEGACY_VERSION) {
    const legacy = parseLegacyOutbox(parsed);
    persistShardedOutbox(storage, legacy);
    return {
      pending: legacy.pending.map((entry) => entry.eventId),
      quarantine: legacy.quarantine.map((entry) => entry.eventId),
    };
  }
  if (parsed.version !== VERSION) throw new Error("Phone IMU outbox is invalid.");
  return { pending: parseIds(parsed.pending), quarantine: parseIds(parsed.quarantine) };
}

function removeStoredEntry(storage: SettingsStorage, queue: QueueName, eventId: string): void {
  storage.removeItem(entryKey(queue, eventId));
}

export function readPhoneImuOutbox(storage: SettingsStorage): PhoneImuOutbox {
  const index = readIndex(storage);
  if (index.pending.length === 0 && index.quarantine.length === 0) return createEmptyOutbox();
  return {
    pending: index.pending.map((eventId) => readStoredEntry(storage, "pending", eventId)),
    quarantine: index.quarantine.map((eventId) => readStoredEntry(storage, "quarantine", eventId)),
  };
}

export function readPhoneImuPendingBatch(
  storage: SettingsStorage,
  limit: number,
): OutboxEntry<PhoneImuEvent>[] {
  const index = readIndex(storage);
  const firstId = index.pending[0];
  if (!firstId) return [];
  const first = readStoredEntry(storage, "pending", firstId);
  const entries = [first];
  for (const eventId of index.pending.slice(1, MAX_PENDING_BATCH_SCAN)) {
    if (entries.length >= limit) break;
    const entry = readStoredEntry(storage, "pending", eventId);
    if (
      entry.payload.source.connectionType === first.payload.source.connectionType &&
      entry.payload.source.installId === first.payload.source.installId
    ) {
      entries.push(entry);
    }
  }
  return entries;
}

export function recordPhoneImuOutboxAttempts(
  storage: SettingsStorage,
  eventIds: readonly string[],
  message: string,
): void {
  const pending = new Set(readIndex(storage).pending);
  for (const eventId of eventIds) {
    if (!pending.has(eventId)) continue;
    const entry = readStoredEntry(storage, "pending", eventId);
    storage.setItem(
      entryKey("pending", eventId),
      serializeEntry({ ...entry, attempts: entry.attempts + 1, lastError: message }),
    );
  }
}

export function acknowledgePhoneImuOutboxEntries(
  storage: SettingsStorage,
  eventIds: readonly string[],
): number {
  const index = readIndex(storage);
  const accepted = new Set(eventIds);
  const removed = index.pending.filter((eventId) => accepted.has(eventId));
  if (removed.length === 0) return 0;
  index.pending = index.pending.filter((eventId) => !accepted.has(eventId));
  persistIndex(storage, index);
  for (const eventId of removed) removeStoredEntry(storage, "pending", eventId);
  return removed.length;
}

export function quarantinePhoneImuOutboxEntry(
  storage: SettingsStorage,
  eventId: string,
  issues: ValidationIssue[],
): boolean {
  const index = readIndex(storage);
  if (!index.pending.includes(eventId)) return false;
  const entry = readStoredEntry(storage, "pending", eventId);
  storage.setItem(entryKey("quarantine", eventId), serializeQuarantineEntry({ ...entry, issues }));
  index.pending = index.pending.filter((candidate) => candidate !== eventId);
  if (!index.quarantine.includes(eventId)) index.quarantine.push(eventId);
  persistIndex(storage, index);
  removeStoredEntry(storage, "pending", eventId);
  return true;
}

export function persistImuEnvelope(
  storage: SettingsStorage,
  envelope: HealthEnvelopeV1<ImuChunkPayload>,
): { acceptedEventIds: string[] } {
  const index = readIndex(storage);
  const known = new Set([...index.pending, ...index.quarantine]);
  for (const event of envelope.events) {
    if (known.has(event.eventId)) continue;
    const entry = {
      eventId: event.eventId,
      createdAt: event.createdAt,
      payload: { source: envelope.source, payload: event.payload },
      attempts: 0,
    } satisfies OutboxEntry<PhoneImuEvent>;
    const key = entryKey("pending", event.eventId);
    const orphaned = storage.getItem(key);
    if (orphaned) parseEntry(JSON.parse(orphaned));
    else storage.setItem(key, serializeEntry(entry));
    index.pending.push(event.eventId);
    known.add(event.eventId);
  }
  persistIndex(storage, index);
  return { acceptedEventIds: envelope.events.map((event) => event.eventId) };
}
