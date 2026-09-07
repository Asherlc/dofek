import type { BackgroundHealthEvent, BackgroundHealthOutbox } from "./background-health.ts";
import { createHealthEnvelope, type HealthEnvelopeV1 } from "./health-contract.ts";
import type { HealthUploadPayload } from "./health-upload.ts";

function uploadPayload(event: BackgroundHealthEvent): HealthUploadPayload {
  if (event.kind === "summary") {
    return { watchSummary: event.summary };
  }
  if (event.kind === "activity") {
    return { activities: [event.activity] };
  }
  return { backgroundSamples: [event.sample] };
}

export function createWatchHealthBatches(
  outbox: BackgroundHealthOutbox,
  installId: string,
  batchSize: number,
): HealthEnvelopeV1<HealthUploadPayload>[] {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error("Watch health batch size must be positive.");
  }

  const batches: HealthEnvelopeV1<HealthUploadPayload>[] = [];
  let current = outbox.pending.slice(0, batchSize);
  let offset = current.length;
  while (current.length > 0) {
    const nextSummaryIndex = current.findIndex(
      (entry, index) => index > 0 && entry.payload.kind === "summary",
    );
    if (nextSummaryIndex !== -1) {
      offset -= current.length - nextSummaryIndex;
      current = current.slice(0, nextSummaryIndex);
    }
    const first = current[0];
    const last = current[current.length - 1];
    if (!first || !last) {
      break;
    }
    batches.push(
      createHealthEnvelope({
        batchId: `${installId}:${first.eventId}:${last.eventId}`,
        source: { connectionType: "zepp", installId },
        events: current.map((entry) => ({
          eventId: entry.eventId,
          createdAt: entry.createdAt,
          payload: uploadPayload(entry.payload),
        })),
      }),
    );
    current = outbox.pending.slice(offset, offset + batchSize);
    offset += current.length;
  }
  return batches;
}
