import type { BackgroundHealthOutbox } from "./background-health.ts";
import { acknowledgeOutboxEntries, quarantineOutboxEntry } from "./durable-outbox.ts";
import { parseHealthUploadResponse } from "./health-contract.ts";
import { createWatchHealthBatches } from "./watch-health-batches.ts";

interface WatchHealthSyncDependencies {
  installId: string;
  initialOutbox: BackgroundHealthOutbox;
  request(envelope: unknown): Promise<unknown>;
  readLatest(): BackgroundHealthOutbox;
  write(outbox: BackgroundHealthOutbox): void;
}

export async function deliverWatchHealthOutbox({
  installId,
  initialOutbox,
  request,
  readLatest,
  write,
}: WatchHealthSyncDependencies): Promise<void> {
  const batches = createWatchHealthBatches(initialOutbox, installId, 100);
  for (const envelope of batches) {
    const response = parseHealthUploadResponse(await request(envelope));
    const submittedEventIds = new Set(envelope.events.map((event) => event.eventId));
    const acceptedEventIds = new Set(response.acceptedEventIds);
    const responseEventIds = [
      ...response.acceptedEventIds,
      ...response.rejected.map((event) => event.eventId),
    ];
    if (responseEventIds.some((eventId) => !submittedEventIds.has(eventId))) {
      throw new Error("Health upload response references an event outside the submitted batch.");
    }
    if (response.rejected.some((event) => acceptedEventIds.has(event.eventId))) {
      throw new Error("Health upload response both accepts and rejects the same event.");
    }
    let updated = acknowledgeOutboxEntries(readLatest(), response.acceptedEventIds);
    for (const rejected of response.rejected) {
      updated = quarantineOutboxEntry(updated, rejected.eventId, rejected.issues);
    }
    write(updated);
  }
}
