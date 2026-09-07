import {
  createHealthEnvelope,
  type HealthEnvelopeV1,
  type HealthUploadResponse,
} from "./health-contract.ts";
import type { ImuConnectionBinding } from "./imu-side-upload.ts";
import type { ImuChunkPayload } from "./imu-upload.ts";
import type { SettingsStorage } from "./phone-health-outbox.ts";
import {
  acknowledgePhoneImuOutboxEntries,
  hasRecoverableLegacyPhoneImuEntries,
  LegacyImuAccountBindingRequiredError,
  quarantinePhoneImuOutboxEntry,
  readPhoneImuPendingBatch,
  recordPhoneImuOutboxAttempts,
  scanPhoneImuPendingBatch,
} from "./phone-imu-outbox.ts";

export type PostImuEnvelope = (
  envelope: HealthEnvelopeV1<ImuChunkPayload>,
  connection: ImuConnectionBinding,
) => Promise<HealthUploadResponse>;

export async function drainPhoneImuOutbox(
  storage: SettingsStorage,
  currentConnection: ImuConnectionBinding | null,
  post: PostImuEnvelope,
): Promise<{ uploaded: number; quarantined: number }> {
  let uploaded = 0;
  let quarantined = 0;
  let scanStartIndex = 0;
  while (true) {
    if (!currentConnection) {
      const [oldest] = readPhoneImuPendingBatch(storage, 1);
      if (!oldest) return { uploaded, quarantined };
      if (hasRecoverableLegacyPhoneImuEntries(storage)) {
        throw new LegacyImuAccountBindingRequiredError();
      }
      throw new Error("Reconnect Dofek to upload retained motion recordings.");
    }
    const scan = scanPhoneImuPendingBatch(storage, 10, currentConnection, scanStartIndex);
    const entries = scan.entries;
    const first = entries[0];
    if (!first) {
      if (scanStartIndex > 0) {
        scanStartIndex = 0;
        continue;
      }
      if (hasRecoverableLegacyPhoneImuEntries(storage)) {
        throw new LegacyImuAccountBindingRequiredError();
      }
      return { uploaded, quarantined };
    }
    const last = entries.at(-1) ?? first;
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
      response = await post(envelope, currentConnection);
    } catch (error) {
      const message = error instanceof Error ? error.message : "IMU upload failed.";
      recordPhoneImuOutboxAttempts(
        storage,
        entries.map((entry) => entry.eventId),
        message,
      );
      throw error;
    }

    const submitted = new Set(entries.map((entry) => entry.eventId));
    const accepted = response.acceptedEventIds.filter((eventId) => submitted.has(eventId));
    uploaded += acknowledgePhoneImuOutboxEntries(storage, accepted);
    for (const rejected of response.rejected) {
      if (!submitted.has(rejected.eventId)) continue;
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
    scanStartIndex = scan.nextStartIndex;
  }
}
