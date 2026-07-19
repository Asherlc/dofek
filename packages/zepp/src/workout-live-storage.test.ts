import { describe, expect, it } from "vitest";
import { parseLiveWorkoutBuffer } from "./workout-live-storage.ts";

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
});
