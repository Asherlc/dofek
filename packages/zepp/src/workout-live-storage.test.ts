import { describe, expect, it } from "vitest";
import {
  parseLiveWorkoutBuffer,
  removeUploadedLiveWorkoutSnapshots,
} from "./workout-live-storage.ts";

describe("parseLiveWorkoutBuffer", () => {
  it("parses a durable live workout buffer", () => {
    const snapshot = {
      recordedAt: "2024-07-03T09:51:52.000Z",
      heartRate: 148,
      metrics: { duration: 312, speed: 3.5 },
    };
    expect(
      parseLiveWorkoutBuffer(
        JSON.stringify({
          batches: [
            { externalId: "1720000000", snapshots: [snapshot] },
            {
              externalId: "1720003600",
              snapshots: [{ ...snapshot, recordedAt: "2024-07-03T10:51:52.000Z" }],
            },
          ],
        }),
      ),
    ).toEqual({
      batches: [
        { externalId: "1720000000", snapshots: [snapshot] },
        {
          externalId: "1720003600",
          snapshots: [{ ...snapshot, recordedAt: "2024-07-03T10:51:52.000Z" }],
        },
      ],
    });
  });

  it("returns an empty buffer for malformed data", () => {
    expect(parseLiveWorkoutBuffer("not-json")).toEqual({ batches: [] });
  });

  it("preserves snapshots collected while an older upload is in flight", () => {
    const uploadedSnapshot = {
      recordedAt: "2024-07-03T09:51:52.000Z",
      metrics: { duration: 312 },
    };
    const newlyCollectedSnapshot = {
      recordedAt: "2024-07-03T09:52:02.000Z",
      metrics: { duration: 322 },
    };
    const otherWorkoutSnapshot = {
      recordedAt: "2024-07-03T10:51:52.000Z",
      metrics: { duration: 120 },
    };

    expect(
      removeUploadedLiveWorkoutSnapshots(
        {
          batches: [
            {
              externalId: "1720000000",
              snapshots: [uploadedSnapshot, newlyCollectedSnapshot],
            },
            { externalId: "1720003600", snapshots: [otherWorkoutSnapshot] },
          ],
        },
        "1720000000",
        [uploadedSnapshot],
      ),
    ).toEqual({
      batches: [
        { externalId: "1720000000", snapshots: [newlyCollectedSnapshot] },
        { externalId: "1720003600", snapshots: [otherWorkoutSnapshot] },
      ],
    });
  });
});
