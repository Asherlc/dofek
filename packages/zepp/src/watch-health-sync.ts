import type { BackgroundHealthOutbox } from "./background-health.ts";
import { acknowledgeOutboxEntries } from "./durable-outbox.ts";
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
    write(acknowledgeOutboxEntries(readLatest(), response.acceptedEventIds));
  }
}
