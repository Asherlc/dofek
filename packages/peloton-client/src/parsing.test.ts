import { describe, expect, it } from "vitest";
import { mapFitnessDiscipline, parsePerformanceGraph, parseWorkout } from "./parsing.ts";
import type { PelotonPerformanceGraph, PelotonWorkout } from "./types.ts";

const workout: PelotonWorkout = {
  id: "workout-1",
  status: "COMPLETE",
  fitness_discipline: "cycling",
  created_at: 1_709_280_000,
  start_time: 1_709_280_000,
  end_time: 1_709_281_800,
  total_work: 360_000,
  is_total_work_personal_record: true,
  timezone: "America/New_York",
  strava_id: "123",
  ride: {
    id: "ride-1",
    title: "Power Zone Ride",
    duration: 1800,
    instructor: { id: "instructor-1", name: "Coach" },
  },
};

describe("mapFitnessDiscipline", () => {
  it("maps Peloton's internal rowing name and unknown values", () => {
    expect(mapFitnessDiscipline("caesar")).toBe("rowing");
    expect(mapFitnessDiscipline("future-discipline")).toBe("other");
  });
});

describe("parseWorkout", () => {
  it("maps timestamps, source identifiers, and raw metadata", () => {
    const parsed = parseWorkout(workout);

    expect(parsed).toMatchObject({
      externalId: "workout-1",
      activityType: "indoor_cycling",
      name: "Power Zone Ride",
      timezone: "America/New_York",
      stravaId: "123",
      startedAt: new Date(1_709_280_000_000),
      endedAt: new Date(1_709_281_800_000),
      raw: {
        instructor: "Coach",
        totalWorkJoules: 360_000,
        isPersonalRecord: true,
      },
    });
  });

  it("treats unfinished workouts and Peloton's unlinked Strava sentinel as absent", () => {
    const parsed = parseWorkout({ ...workout, end_time: 0, strava_id: "-1" });

    expect(parsed.endedAt).toBeUndefined();
    expect(parsed.stravaId).toBeUndefined();
  });
});

describe("parsePerformanceGraph", () => {
  it("adds offsets at the requested sample interval", () => {
    const graph: PelotonPerformanceGraph = {
      duration: 15,
      is_class_plan_shown: false,
      segment_list: [],
      average_summaries: [],
      summaries: [],
      metrics: [
        {
          display_name: "Heart Rate",
          slug: "heart_rate",
          values: [120, 130, 140],
          average_value: 130,
          max_value: 140,
        },
      ],
    };

    expect(parsePerformanceGraph(graph, 5)[0]).toMatchObject({
      offsetsSeconds: [0, 5, 10],
      displayName: "Heart Rate",
    });
  });
});
