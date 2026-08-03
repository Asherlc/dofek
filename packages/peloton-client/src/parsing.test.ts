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
  device_type: "bike",
  platform: "home_bike",
  peloton_id: "class-1",
  workout_type: "live",
  timezone: "America/New_York",
  strava_id: "123",
  ride: {
    id: "ride-1",
    title: "Power Zone Ride",
    description: "Endurance work",
    duration: 1800,
    difficulty_rating_avg: 7.5,
    overall_rating_avg: 99,
    instructor: { id: "instructor-1", name: "Coach" },
  },
};

describe("mapFitnessDiscipline", () => {
  it("maps Peloton's internal rowing name and unknown values", () => {
    expect(mapFitnessDiscipline("caesar").canonicalType).toBe("rowing");
    expect(mapFitnessDiscipline("future-discipline").canonicalType).toBe("other");
  });
});

describe("parseWorkout", () => {
  it("maps timestamps, source identifiers, and raw metadata", () => {
    const parsed = parseWorkout(workout);

    expect(parsed).toEqual({
      externalId: "workout-1",
      activityType: {
        canonicalType: "cycling",
        providerType: "cycling",
        modality: "indoor",
      },
      name: "Power Zone Ride",
      timezone: "America/New_York",
      stravaId: "123",
      startedAt: new Date(1_709_280_000_000),
      endedAt: new Date(1_709_281_800_000),
      raw: {
        instructor: "Coach",
        classTitle: "Power Zone Ride",
        difficultyRating: 7.5,
        overallRating: 99,
        rideDescription: "Endurance work",
        leaderboardRank: undefined,
        totalLeaderboardUsers: undefined,
        totalWorkJoules: 360_000,
        isPersonalRecord: true,
        fitnessDiscipline: "cycling",
        pelotonRideId: "ride-1",
        deviceType: "bike",
        platform: "home_bike",
        pelotonClassId: "class-1",
        workoutType: "live",
        hasPedalingMetrics: undefined,
        timezone: "America/New_York",
      },
    });
  });

  it("treats unfinished workouts and Peloton's unlinked Strava sentinel as absent", () => {
    const parsed = parseWorkout({
      ...workout,
      end_time: 0,
      strava_id: "-1",
      ride: undefined,
      total_work: 0,
      is_total_work_personal_record: false,
      device_type: undefined,
      platform: undefined,
      peloton_id: undefined,
      workout_type: undefined,
      timezone: undefined,
    });

    expect(parsed.endedAt).toBeUndefined();
    expect(parsed.stravaId).toBeUndefined();
    expect(parsed.name).toBeUndefined();
    expect(parsed.timezone).toBeUndefined();
    expect(parsed.raw).toEqual({
      instructor: undefined,
      classTitle: undefined,
      difficultyRating: undefined,
      overallRating: undefined,
      rideDescription: undefined,
      leaderboardRank: undefined,
      totalLeaderboardUsers: undefined,
      totalWorkJoules: undefined,
      isPersonalRecord: undefined,
      fitnessDiscipline: "cycling",
      pelotonRideId: undefined,
      deviceType: undefined,
      platform: undefined,
      pelotonClassId: undefined,
      workoutType: undefined,
      hasPedalingMetrics: undefined,
      timezone: undefined,
    });
  });

  it("handles rides without an instructor", () => {
    const parsed = parseWorkout({
      ...workout,
      ride: { id: "ride-1", title: "Solo Ride", duration: 1800 },
    });

    expect(parsed.raw.instructor).toBeUndefined();
  });

  it("treats nullable completion and source identifiers as absent", () => {
    const parsed = parseWorkout({
      ...workout,
      end_time: null,
      peloton_id: null,
      strava_id: null,
    });

    expect(parsed.endedAt).toBeUndefined();
    expect(parsed.stravaId).toBeUndefined();
    expect(parsed.raw.pelotonClassId).toBeUndefined();
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
