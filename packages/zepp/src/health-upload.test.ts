import { describe, expect, it } from "vitest";
import type { HealthActivity } from "./health-collector.ts";
import { createHealthUploadBatches, mergeHealthActivities } from "./health-upload.ts";

describe("createHealthUploadBatches", () => {
  it("sends the summary once and splits the durable background buffer", () => {
    const watchSummary = {
      collectedAt: 1_720_000_000_000,
      date: "2024-07-03",
      timezoneOffsetMinutes: 0,
    };
    const activities: HealthActivity[] = [
      {
        externalId: "1720000000",
        activityType: "other",
        startedAt: "2024-07-03T09:46:40.000Z",
        endedAt: "2024-07-03T10:46:40.000Z",
      },
    ];
    const backgroundSamples = Array.from({ length: 1_201 }, (_, index) => ({
      recordedAt: new Date(1_720_000_000_000 + index * 60_000).toISOString(),
      heartRate: 60 + (index % 40),
    }));

    const batches = createHealthUploadBatches(watchSummary, activities, backgroundSamples);

    expect(batches.map((batch) => batch.backgroundSamples?.length)).toEqual([500, 500, 201]);
    expect(batches[0]).toMatchObject({ watchSummary, activities });
    expect(batches[1]?.watchSummary).toBeUndefined();
    expect(batches[1]?.activities).toBeUndefined();
  });

  it("keeps fresh workout history when it overlaps the background buffer", () => {
    const buffered: HealthActivity = {
      externalId: "1720000000",
      activityType: "other",
      startedAt: "2024-07-03T09:46:40.000Z",
      endedAt: "2024-07-03T09:51:52.000Z",
    };
    const fresh: HealthActivity = {
      ...buffered,
      endedAt: "2024-07-03T10:46:40.000Z",
    };

    expect(mergeHealthActivities([fresh], [buffered])).toEqual([fresh]);
  });

  it("still uploads a summary when the background buffer is empty", () => {
    const watchSummary = {
      collectedAt: 1_720_000_000_000,
      date: "2024-07-03",
      timezoneOffsetMinutes: 0,
    };

    expect(createHealthUploadBatches(watchSummary, [], [])).toEqual([
      { watchSummary, activities: [], backgroundSamples: [] },
    ]);
  });
});
