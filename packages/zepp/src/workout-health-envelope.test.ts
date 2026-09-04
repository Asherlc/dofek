import { describe, expect, it } from "vitest";
import {
  createWorkoutHealthEnvelope,
  isWorkoutHealthEventAcknowledged,
} from "./workout-health-envelope.ts";

describe("createWorkoutHealthEnvelope", () => {
  it("creates a deterministic, replay-safe event for a persisted workout snapshot batch", () => {
    const snapshots = [
      { recordedAt: "2024-07-03T09:51:52.000Z", metrics: { duration: 312 } },
      { recordedAt: "2024-07-03T09:52:02.000Z", heartRate: 148, metrics: { duration: 322 } },
    ];

    expect(createWorkoutHealthEnvelope("install-1", "1720000000", snapshots)).toEqual({
      version: 1,
      batchId: "install-1:workout:1720000000:2024-07-03T09:51:52.000Z:2024-07-03T09:52:02.000Z",
      source: { connectionType: "zepp-workout", installId: "install-1" },
      events: [
        {
          eventId: "install-1:workout:1720000000:2024-07-03T09:51:52.000Z:2024-07-03T09:52:02.000Z",
          createdAt: "2024-07-03T09:52:02.000Z",
          payload: {
            activities: [
              {
                externalId: "1720000000",
                activityType: "other",
                startedAt: "2024-07-03T09:46:40.000Z",
                endedAt: "2024-07-03T09:52:02.000Z",
                raw: {
                  liveSnapshotsByRecordedAt: {
                    "2024-07-03T09:51:52.000Z": snapshots[0],
                    "2024-07-03T09:52:02.000Z": snapshots[1],
                  },
                },
              },
            ],
            liveWorkoutSamples: [
              { externalId: "1720000000", ...snapshots[0] },
              { externalId: "1720000000", ...snapshots[1] },
            ],
          },
        },
      ],
    });
  });
});

describe("isWorkoutHealthEventAcknowledged", () => {
  it("accepts only a response that names the exact durable event", () => {
    expect(
      isWorkoutHealthEventAcknowledged(
        { status: "ok", acceptedEventIds: ["event-1"], rejected: [] },
        "event-1",
      ),
    ).toBe(true);
    expect(
      isWorkoutHealthEventAcknowledged({ status: "ok", acceptedEventIds: [] }, "event-1"),
    ).toBe(false);
    expect(isWorkoutHealthEventAcknowledged(null, "event-1")).toBe(false);
  });
});
