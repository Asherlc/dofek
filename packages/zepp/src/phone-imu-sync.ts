import {
  acknowledgeOutboxEntries,
  quarantineOutboxEntry,
  recordOutboxAttempt,
} from "./durable-outbox.ts";
import {
  createHealthEnvelope,
  type HealthEnvelopeV1,
  type HealthUploadResponse,
} from "./health-contract.ts";
import type { ImuChunkPayload } from "./imu-upload.ts";
import type { SettingsStorage } from "./phone-health-outbox.ts";
import { readPhoneImuOutbox, writePhoneImuOutbox } from "./phone-imu-outbox.ts";

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
    const initial = readPhoneImuOutbox(storage);
    const first = initial.pending[0];
    const entries = first
      ? initial.pending
          .filter(
            (entry) =>
              entry.payload.source.connectionType === first.payload.source.connectionType &&
              entry.payload.source.installId === first.payload.source.installId,
          )
          .slice(0, 10)
      : [];
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
      let latest = readPhoneImuOutbox(storage);
      const message = error instanceof Error ? error.message : "IMU upload failed.";
      for (const entry of entries) {
        latest = recordOutboxAttempt(latest, entry.eventId, message);
      }
      writePhoneImuOutbox(storage, latest);
      throw error;
    }

    let latest = readPhoneImuOutbox(storage);
    const batchIds = new Set(entries.map((entry) => entry.eventId));
    const accepted = response.acceptedEventIds.filter((eventId) => batchIds.has(eventId));
    latest = acknowledgeOutboxEntries(latest, accepted);
    uploaded += accepted.length;
    for (const rejected of response.rejected) {
      if (!batchIds.has(rejected.eventId)) continue;
      const wasPending = latest.pending.some((entry) => entry.eventId === rejected.eventId);
      latest = quarantineOutboxEntry(latest, rejected.eventId, rejected.issues);
      if (wasPending) quarantined += 1;
    }
    const resolved = new Set([...accepted, ...response.rejected.map((event) => event.eventId)]);
    const unresolved = entries.filter((entry) => !resolved.has(entry.eventId));
    if (unresolved.length > 0) {
      const message = `Server did not acknowledge ${unresolved.length} IMU chunks.`;
      for (const entry of unresolved) {
        latest = recordOutboxAttempt(latest, entry.eventId, message);
      }
      writePhoneImuOutbox(storage, latest);
      throw new Error(message);
    }
    writePhoneImuOutbox(storage, latest);
  }
}
