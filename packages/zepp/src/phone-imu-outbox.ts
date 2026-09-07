import { createEmptyOutbox, type DurableOutbox, type OutboxEntry } from "./durable-outbox.ts";
import type { ValidationIssue, ZeppConnectionType } from "./health-contract.ts";
import type { ImuChunkPayload, ImuConnectionBinding, ImuEnvelope } from "./imu-upload.ts";
import { parseImuConnectionBinding, parseImuEnvelope } from "./imu-upload.ts";
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
  connection?: LegacyImuConnectionReceipt | ImuConnectionBinding;
}

interface LegacyImuConnectionReceipt {
  serverUrl: string;
  token: string;
}

export type PhoneImuOutbox = DurableOutbox<PhoneImuEvent>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConnection(
  value: unknown,
): LegacyImuConnectionReceipt | ImuConnectionBinding | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.serverUrl !== "string" || !value.serverUrl.trim()) {
    throw new Error("Phone IMU connection binding is invalid.");
  }
  if (typeof value.accountId === "string" && value.accountId.trim() && !("token" in value)) {
    return { serverUrl: value.serverUrl, accountId: value.accountId };
  }
  if (typeof value.token === "string" && value.token.trim() && !("accountId" in value)) {
    return { serverUrl: value.serverUrl, token: value.token };
  }
  throw new Error("Phone IMU connection binding is invalid.");
}

function sameConnection(
  left: PhoneImuEvent["connection"],
  right: PhoneImuEvent["connection"],
): boolean {
  if (!left || !right) return left === right;
  if (left.serverUrl !== right.serverUrl) return false;
  return "accountId" in left
    ? "accountId" in right && left.accountId === right.accountId
    : "token" in right && left.token === right.token;
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
    payload: {
      source: envelope.source,
      payload: event.payload,
      connection: parseConnection(value.payload.connection),
    },
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
  connection?: ImuConnectionBinding,
): OutboxEntry<PhoneImuEvent>[] {
  const index = readIndex(storage);
  let first: OutboxEntry<PhoneImuEvent> | undefined;
  let firstIndex = -1;
  for (const [indexPosition, eventId] of index.pending.entries()) {
    const entry = readStoredEntry(storage, "pending", eventId);
    if (connection && !sameConnection(entry.payload.connection, connection)) continue;
    first = entry;
    firstIndex = indexPosition;
    break;
  }
  if (!first) return [];
  const entries = [first];
  for (const eventId of index.pending.slice(firstIndex + 1, firstIndex + MAX_PENDING_BATCH_SCAN)) {
    if (entries.length >= limit) break;
    const entry = readStoredEntry(storage, "pending", eventId);
    if (
      entry.payload.source.connectionType === first.payload.source.connectionType &&
      entry.payload.source.installId === first.payload.source.installId &&
      sameConnection(entry.payload.connection, first.payload.connection)
    ) {
      entries.push(entry);
    }
  }
  return entries;
}

export function hasRecoverableLegacyPhoneImuEntries(storage: SettingsStorage): boolean {
  const index = readIndex(storage);
  const hasPending = index.pending.some((eventId) => {
    const connection = readStoredEntry(storage, "pending", eventId).payload.connection;
    return !connection || !("accountId" in connection);
  });
  if (hasPending) return true;
  return index.quarantine.some((eventId) => {
    const entry = readStoredEntry(storage, "quarantine", eventId);
    const isLegacy = !entry.payload.connection || !("accountId" in entry.payload.connection);
    return isLegacy && entry.issues.some((issue) => issue.path === "connection");
  });
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
  envelope: ImuEnvelope,
  legacyRecoveryBinding?: ImuConnectionBinding,
): { acceptedEventIds: string[] } {
  const connection = envelope.destination
    ? parseImuConnectionBinding(envelope.destination)
    : legacyRecoveryBinding
      ? parseImuConnectionBinding(legacyRecoveryBinding)
      : undefined;
  if (!connection) {
    throw new LegacyImuAccountBindingRequiredError();
  }
  const index = readIndex(storage);
  const known = new Set([...index.pending, ...index.quarantine]);
  for (const event of envelope.events) {
    if (known.has(event.eventId)) continue;
    const entry = {
      eventId: event.eventId,
      createdAt: event.createdAt,
      payload: { source: envelope.source, payload: event.payload, connection },
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

export class LegacyImuAccountBindingRequiredError extends Error {
  constructor() {
    super("Choose the account for retained motion recordings in Zepp settings.");
    this.name = "LegacyImuAccountBindingRequiredError";
  }
}

export function assignLegacyPhoneImuOutbox(
  storage: SettingsStorage,
  binding: ImuConnectionBinding,
): number {
  const connection = parseImuConnectionBinding(binding);
  const index = readIndex(storage);
  let assigned = 0;
  for (const eventId of index.pending) {
    const entry = readStoredEntry(storage, "pending", eventId);
    if (entry.payload.connection && "accountId" in entry.payload.connection) continue;
    storage.setItem(
      entryKey("pending", eventId),
      serializeEntry({
        ...entry,
        payload: { ...entry.payload, connection },
      }),
    );
    assigned += 1;
  }
  const reassignedQuarantineIds: string[] = [];
  for (const eventId of [...index.quarantine]) {
    const entry = readStoredEntry(storage, "quarantine", eventId);
    if (
      (entry.payload.connection && "accountId" in entry.payload.connection) ||
      !entry.issues.some((issue) => issue.path === "connection")
    ) {
      continue;
    }
    storage.setItem(
      entryKey("pending", eventId),
      serializeEntry({
        eventId: entry.eventId,
        createdAt: entry.createdAt,
        payload: { ...entry.payload, connection },
        attempts: entry.attempts,
        ...(entry.lastError ? { lastError: entry.lastError } : {}),
      }),
    );
    index.quarantine = index.quarantine.filter((candidate) => candidate !== eventId);
    if (!index.pending.includes(eventId)) index.pending.push(eventId);
    reassignedQuarantineIds.push(eventId);
    assigned += 1;
  }
  persistIndex(storage, index);
  for (const eventId of reassignedQuarantineIds) {
    removeStoredEntry(storage, "quarantine", eventId);
  }
  return assigned;
}
