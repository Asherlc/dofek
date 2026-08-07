import { resolveProviderActivityType } from "@dofek/training/activity-types";
import { describe, expect, it } from "vitest";
import { buildHangTenIntervals } from "./hang-ten-intervals.ts";
import type { HealthWorkout } from "./workouts.ts";

describe("buildHangTenIntervals", () => {
  it("keeps later intervals at the last known time after a missing duration", () => {
    const start = new Date("2026-08-07T14:00:00Z");
    const workout: HealthWorkout = {
      activityType: resolveProviderActivityType("Hang Ten", "hangboard"),
      sourceName: "Hang Ten",
      durationSeconds: 60,
      startDate: start,
      endDate: new Date("2026-08-07T14:01:00Z"),
      hangTen: {
        planName: "Repeaters",
        activitySegments: [
          {
            stepID: "step-1",
            stepNumber: 1,
            kind: "work",
            holdIDs: ["edge-19"],
            holdType: "edge",
            sizeMillimeters: 19,
            durationSeconds: 7,
          },
          {
            stepID: "step-1-rest",
            stepNumber: 1,
            kind: "rest",
            holdIDs: [],
            durationSeconds: 3,
          },
          {
            stepID: "step-2",
            stepNumber: 2,
            kind: "work",
            holdIDs: ["jug"],
          },
          {
            stepID: "step-2-rest",
            stepNumber: 2,
            kind: "rest",
            holdIDs: [],
            durationSeconds: 5,
          },
        ],
      },
    };

    expect(buildHangTenIntervals("act-1", workout)).toEqual([
      expect.objectContaining({
        activityId: "act-1",
        intervalIndex: 0,
        label: "Step 1: 19 mm edge",
        intervalType: "work",
        startedAt: start,
        endedAt: new Date("2026-08-07T14:00:07Z"),
      }),
      expect.objectContaining({
        activityId: "act-1",
        intervalIndex: 1,
        label: "Step 1: Rest",
        intervalType: "rest",
        startedAt: new Date("2026-08-07T14:00:07Z"),
        endedAt: new Date("2026-08-07T14:00:10Z"),
      }),
      expect.objectContaining({
        activityId: "act-1",
        intervalIndex: 2,
        label: "Step 2: Work",
        intervalType: "work",
        startedAt: new Date("2026-08-07T14:00:10Z"),
        endedAt: undefined,
      }),
      expect.objectContaining({
        activityId: "act-1",
        intervalIndex: 3,
        label: "Step 2: Rest",
        intervalType: "rest",
        startedAt: new Date("2026-08-07T14:00:10Z"),
        endedAt: undefined,
      }),
    ]);
  });
});
