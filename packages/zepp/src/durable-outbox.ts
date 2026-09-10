import type { ValidationIssue } from "./health-contract.ts";

export interface OutboxEntry<T> {
  eventId: string;
  createdAt: string;
  payload: T;
  attempts: number;
  lastError?: string;
}

export type QuarantinedOutboxEntry<T> = OutboxEntry<T> & {
  issues: ValidationIssue[];
};

export interface DurableOutbox<T> {
  pending: OutboxEntry<T>[];
  quarantine: QuarantinedOutboxEntry<T>[];
}

export function createEmptyOutbox<T>(): DurableOutbox<T> {
  return { pending: [], quarantine: [] };
}

export function appendOutboxEntry<T>(
  outbox: DurableOutbox<T>,
  entry: OutboxEntry<T>,
): DurableOutbox<T> {
  if (
    outbox.pending.some((candidate) => candidate.eventId === entry.eventId) ||
    outbox.quarantine.some((candidate) => candidate.eventId === entry.eventId)
  ) {
    return outbox;
  }
  return { ...outbox, pending: [...outbox.pending, entry] };
}

export function getOutboxBatch<T>(outbox: DurableOutbox<T>, size: number): OutboxEntry<T>[] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error("Outbox batch size must be positive.");
  }
  return outbox.pending.slice(0, size);
}

export function acknowledgeOutboxEntries<T>(
  outbox: DurableOutbox<T>,
  eventIds: readonly string[],
): DurableOutbox<T> {
  const accepted = new Set(eventIds);
  return {
    ...outbox,
    pending: outbox.pending.filter((entry) => !accepted.has(entry.eventId)),
  };
}

export function recordOutboxAttempt<T>(
  outbox: DurableOutbox<T>,
  eventId: string,
  error: string,
): DurableOutbox<T> {
  const index = outbox.pending.findIndex((entry) => entry.eventId === eventId);
  if (index === -1) {
    return outbox;
  }
  return {
    ...outbox,
    pending: outbox.pending.map((entry, entryIndex) =>
      entryIndex === index ? { ...entry, attempts: entry.attempts + 1, lastError: error } : entry,
    ),
  };
}

export function quarantineOutboxEntry<T>(
  outbox: DurableOutbox<T>,
  eventId: string,
  issues: ValidationIssue[],
): DurableOutbox<T> {
  const entry = outbox.pending.find((candidate) => candidate.eventId === eventId);
  if (!entry) {
    return outbox;
  }
  return {
    pending: outbox.pending.filter((candidate) => candidate.eventId !== eventId),
    quarantine: [...outbox.quarantine, { ...entry, issues }],
  };
}
