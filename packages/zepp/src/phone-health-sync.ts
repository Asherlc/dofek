import {
  acknowledgeOutboxEntries,
  type OutboxEntry,
  quarantineOutboxEntry,
  recordOutboxAttempt,
} from "./durable-outbox.ts";
import {
  createHealthEnvelope,
  type HealthEnvelopeV1,
  type HealthUploadResponse,
} from "./health-contract.ts";
import type { HealthUploadPayload } from "./health-upload.ts";
import {
  type PhoneHealthEvent,
  readPhoneHealthOutbox,
  type SettingsStorage,
  writePhoneHealthOutbox,
} from "./phone-health-outbox.ts";

const PHONE_UPLOAD_BATCH_SIZE = 100;

export type PostHealthEnvelope = (
  envelope: HealthEnvelopeV1<HealthUploadPayload>,
) => Promise<HealthUploadResponse>;

function containsSummary(entry: OutboxEntry<PhoneHealthEvent>): boolean {
  return entry.payload.payload.watchSummary !== undefined;
}

function nextBatch(pending: OutboxEntry<PhoneHealthEvent>[]): OutboxEntry<PhoneHealthEvent>[] {
  const first = pending[0];
  if (!first) {
    return [];
  }
  const batch: OutboxEntry<PhoneHealthEvent>[] = [];
  let hasSummary = false;
  for (const entry of pending) {
    if (
      batch.length >= PHONE_UPLOAD_BATCH_SIZE ||
      entry.payload.source.connectionType !== first.payload.source.connectionType ||
      entry.payload.source.installId !== first.payload.source.installId ||
      (hasSummary && containsSummary(entry))
    ) {
      break;
    }
    batch.push(entry);
    hasSummary ||= containsSummary(entry);
  }
  return batch;
}

function createBatchEnvelope(
  entries: OutboxEntry<PhoneHealthEvent>[],
): HealthEnvelopeV1<HealthUploadPayload> {
  const first = entries[0];
  const last = entries[entries.length - 1];
  if (!first || !last) {
    throw new Error("Cannot upload an empty phone health batch.");
  }
  return createHealthEnvelope({
    batchId: `phone:${first.payload.source.installId}:${first.eventId}:${last.eventId}`,
    source: first.payload.source,
    events: entries.map((entry) => ({
      eventId: entry.eventId,
      createdAt: entry.createdAt,
      payload: entry.payload.payload,
    })),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Health upload failed.";
}

export async function drainPhoneHealthOutbox(
  storage: SettingsStorage,
  post: PostHealthEnvelope,
): Promise<{ uploaded: number; quarantined: number }> {
  let uploaded = 0;
  let quarantined = 0;

  while (true) {
    let outbox = readPhoneHealthOutbox(storage);
    const entries = nextBatch(outbox.pending);
    if (entries.length === 0) {
      return { uploaded, quarantined };
    }

    let response: HealthUploadResponse;
    try {
      response = await post(createBatchEnvelope(entries));
    } catch (error) {
      const message = errorMessage(error);
      for (const entry of entries) {
        outbox = recordOutboxAttempt(outbox, entry.eventId, message);
      }
      writePhoneHealthOutbox(storage, outbox);
      throw error;
    }

    const batchIds = new Set(entries.map((entry) => entry.eventId));
    const acceptedEventIds = response.acceptedEventIds.filter((eventId) => batchIds.has(eventId));
    outbox = acknowledgeOutboxEntries(outbox, acceptedEventIds);
    uploaded += acceptedEventIds.length;

    for (const rejected of response.rejected) {
      if (batchIds.has(rejected.eventId)) {
        const wasPending = outbox.pending.some((entry) => entry.eventId === rejected.eventId);
        outbox = quarantineOutboxEntry(outbox, rejected.eventId, rejected.issues);
        if (wasPending) {
          quarantined += 1;
        }
      }
    }

    const resolvedIds = new Set([
      ...acceptedEventIds,
      ...response.rejected.map((event) => event.eventId),
    ]);
    const unresolved = entries.filter((entry) => !resolvedIds.has(entry.eventId));
    if (unresolved.length > 0) {
      const message = `Server did not acknowledge ${unresolved.length} health events.`;
      for (const entry of unresolved) {
        outbox = recordOutboxAttempt(outbox, entry.eventId, message);
      }
      writePhoneHealthOutbox(storage, outbox);
      throw new Error(message);
    }

    writePhoneHealthOutbox(storage, outbox);
  }
}
