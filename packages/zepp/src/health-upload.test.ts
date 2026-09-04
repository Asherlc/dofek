import { describe, expect, it } from "vitest";
import { parseHealthUploadPayload } from "./health-upload.ts";

describe("parseHealthUploadPayload", () => {
  it("validates and normalizes every upload section", () => {
    expect(
      parseHealthUploadPayload({
        privateValue: "discard",
        watchSummary: {
          collectedAt: 1_720_003_700_000,
          date: "2024-07-03",
          timezoneOffsetMinutes: 0,
          sleep: {
            score: 80,
            deepMinutes: 90,
            startTime: 10,
            endTime: 20,
            totalTime: 480,
            stages: [{ model: 1, start: 10, stop: 20 }],
          },
        },
        activities: [
          {
            externalId: "activity-1",
            activityType: "other",
            startedAt: "2024-07-03T10:00:00.000Z",
            endedAt: "2024-07-03T10:30:00.000Z",
            raw: { source: "watch" },
          },
        ],
        backgroundSamples: [{ recordedAt: "2024-07-03T10:48:20.000Z", heartRate: 72 }],
        liveWorkoutSamples: [
          {
            externalId: "activity-1",
            recordedAt: "2024-07-03T10:20:00.000Z",
            heartRate: 140,
            metrics: { duration: 1200 },
          },
        ],
      }),
    ).toEqual({
      watchSummary: {
        collectedAt: 1_720_003_700_000,
        date: "2024-07-03",
        timezoneOffsetMinutes: 0,
        sleep: {
          score: 80,
          deepMinutes: 90,
          startTime: 10,
          endTime: 20,
          totalTime: 480,
          stages: [{ model: 1, start: 10, stop: 20 }],
        },
      },
      activities: [
        {
          externalId: "activity-1",
          activityType: "other",
          startedAt: "2024-07-03T10:00:00.000Z",
          endedAt: "2024-07-03T10:30:00.000Z",
          raw: { source: "watch" },
        },
      ],
      backgroundSamples: [{ recordedAt: "2024-07-03T10:48:20.000Z", heartRate: 72 }],
      liveWorkoutSamples: [
        {
          externalId: "activity-1",
          recordedAt: "2024-07-03T10:20:00.000Z",
          heartRate: 140,
          metrics: { duration: 1200 },
        },
      ],
    });
  });

  it.each([
    {},
    { backgroundSamples: [{ recordedAt: 123 }] },
    { activities: [{ activityType: "other" }] },
    { liveWorkoutSamples: [{ externalId: "x", recordedAt: "now", metrics: { speed: NaN } }] },
    { watchSummary: { collectedAt: 1, date: "2024-07-03", timezoneOffsetMinutes: "zero" } },
  ])("rejects malformed payload %#", (payload) => {
    expect(() => parseHealthUploadPayload(payload)).toThrow("Health upload payload is invalid.");
  });
});
