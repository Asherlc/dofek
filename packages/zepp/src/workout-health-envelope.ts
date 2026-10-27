import type { HealthEnvelopeV1 } from "./health-contract.ts";
import type { HealthUploadPayload } from "./health-upload.ts";
import type { LiveWorkoutSnapshot } from "./workout-live.ts";

export function createWorkoutHealthEnvelope(
  installId: string,
  externalId: string,
  snapshots: LiveWorkoutSnapshot[],
): HealthEnvelopeV1<HealthUploadPayload> {
  const firstSnapshot = snapshots[0];
  const latestSnapshot = snapshots.at(-1);
  if (!firstSnapshot || !latestSnapshot) {
    throw new Error("Cannot create a workout upload from an empty snapshot batch.");
  }
  const eventId = `${installId}:workout:${externalId}:${firstSnapshot.recordedAt}:${latestSnapshot.recordedAt}`;
  const durationSeconds = latestSnapshot.metrics.duration ?? 0;
  const firstDurationSeconds = firstSnapshot.metrics.duration ?? durationSeconds;
  const firstRecordedAtMs = new Date(firstSnapshot.recordedAt).getTime();
  const latestRecordedAtMs = new Date(latestSnapshot.recordedAt).getTime();
  if (!Number.isFinite(firstRecordedAtMs) || !Number.isFinite(latestRecordedAtMs)) {
    throw new Error("Workout snapshot timestamp is invalid.");
  }
  const startedAtMs = firstRecordedAtMs - firstDurationSeconds * 1000;
  const startedAt = new Date(startedAtMs).toISOString();
  const endedAt = new Date(startedAtMs + durationSeconds * 1000).toISOString();

  return {
    version: 1,
    batchId: eventId,
    source: { connectionType: "zepp-workout", installId },
    events: [
      {
        eventId,
        createdAt: latestSnapshot.recordedAt,
        payload: {
          activities: [
            {
              externalId,
              activityType: "other",
              startedAt,
              endedAt,
              raw: {
                liveSnapshotsByRecordedAt: Object.fromEntries(
                  snapshots.map((snapshot) => [snapshot.recordedAt, snapshot]),
                ),
              },
            },
          ],
          liveWorkoutSamples: snapshots.map((snapshot) => ({ externalId, ...snapshot })),
        },
      },
    ],
  };
}

export function isWorkoutHealthEventAcknowledged(value: unknown, eventId: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const acceptedEventIds = Reflect.get(value, "acceptedEventIds");
  return Array.isArray(acceptedEventIds) && acceptedEventIds.includes(eventId);
}
