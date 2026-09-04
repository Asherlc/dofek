import {
  createHealthEnvelope,
  type HealthEnvelopeV1,
  type HealthUploadResponse,
} from "./health-contract.ts";
import type { ImuChunkPayload } from "./imu-upload.ts";
import type { SettingsStorage } from "./phone-health-outbox.ts";
import {
  acknowledgePhoneImuOutboxEntries,
  quarantinePhoneImuOutboxEntry,
  readPhoneImuPendingBatch,
  recordPhoneImuOutboxAttempts,
} from "./phone-imu-outbox.ts";

export type PostImuEnvelope = (
  envelope: HealthEnvelopeV1<ImuChunkPayload>,
) => Promise<HealthUploadResponse>;

export async function drainPhoneImuOutbox(
  storage: SettingsStorage,
  post: PostImuEnvelope,
): Promise<{ uploaded: number; quarantined: number }> {
  let uploaded = 0;
  let quarantined = 0;
  while (true) {
    const entries = readPhoneImuPendingBatch(storage, 10);
    const first = entries[0];
    const last = entries.at(-1);
    if (!first || !last) return { uploaded, quarantined };
    const envelope = createHealthEnvelope<ImuChunkPayload>({
      batchId: `phone-imu:${first.eventId}:${last.eventId}`,
      source: first.payload.source,
      events: entries.map((entry) => ({
        eventId: entry.eventId,
        createdAt: entry.createdAt,
        payload: entry.payload.payload,
      })),
    });

    let response: HealthUploadResponse;
    try {
      response = await post(envelope);
    } catch (error) {
      const message = error instanceof Error ? error.message : "IMU upload failed.";
      recordPhoneImuOutboxAttempts(
        storage,
        entries.map((entry) => entry.eventId),
        message,
      );
      throw error;
    }

    const batchIds = new Set(entries.map((entry) => entry.eventId));
    const accepted = response.acceptedEventIds.filter((eventId) => batchIds.has(eventId));
    uploaded += acknowledgePhoneImuOutboxEntries(storage, accepted);
    for (const rejected of response.rejected) {
      if (!batchIds.has(rejected.eventId)) continue;
      if (quarantinePhoneImuOutboxEntry(storage, rejected.eventId, rejected.issues)) {
        quarantined += 1;
      }
    }
    const resolved = new Set([...accepted, ...response.rejected.map((event) => event.eventId)]);
    const unresolved = entries.filter((entry) => !resolved.has(entry.eventId));
    if (unresolved.length > 0) {
      const message = `Server did not acknowledge ${unresolved.length} IMU chunks.`;
      recordPhoneImuOutboxAttempts(
        storage,
        unresolved.map((entry) => entry.eventId),
        message,
      );
      throw new Error(message);
    }
  }
}
