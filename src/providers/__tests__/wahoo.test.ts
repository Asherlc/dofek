import { describe, it, expect, vi } from "vitest";
import {
  parseWorkoutSummary,
  parseWorkoutList,
  type WahooWorkout,
  type WahooWorkoutSummary,
} from "../wahoo.js";

const sampleWorkoutSummary: WahooWorkoutSummary = {
  id: 101,
  ascent_accum: 350.5,
  cadence_avg: 85.2,
  calories_accum: 1500,
  distance_accum: 42000.0,
  duration_active_accum: 5400,
  duration_paused_accum: 120,
  duration_total_accum: 5520,
  heart_rate_avg: 145.3,
  power_bike_np_last: 220,
  power_bike_tss_last: 85.5,
  power_avg: 195.8,
  speed_avg: 7.78,
  work_accum: 1056000,
  created_at: "2025-03-01T10:00:00.000Z",
  updated_at: "2025-03-01T10:30:00.000Z",
  file: { url: "https://cdn.wahoo.com/files/123.fit" },
};

const sampleWorkout: WahooWorkout = {
  id: 42,
  name: "Morning Ride",
  workout_token: "abc-123",
  workout_type_id: 0,
  starts: "2025-03-01T08:00:00.000Z",
  minutes: 92,
  created_at: "2025-03-01T10:00:00.000Z",
  updated_at: "2025-03-01T10:30:00.000Z",
  workout_summary: sampleWorkoutSummary,
};

describe("Wahoo Provider", () => {
  describe("parseWorkoutSummary", () => {
    it("maps Wahoo workout summary to cardio activity fields", () => {
      const result = parseWorkoutSummary(sampleWorkout);

      expect(result.externalId).toBe("42");
      expect(result.activityType).toBe("cycling");
      expect(result.startedAt).toEqual(new Date("2025-03-01T08:00:00.000Z"));
      expect(result.durationSeconds).toBe(5400);
      expect(result.distanceMeters).toBeCloseTo(42000.0);
      expect(result.calories).toBe(1500);
      expect(result.avgHeartRate).toBe(145);
      expect(result.avgPower).toBe(196);
      expect(result.avgSpeed).toBeCloseTo(7.78);
      expect(result.avgCadence).toBe(85);
      expect(result.totalElevationGain).toBeCloseTo(350.5);
      expect(result.normalizedPower).toBe(220);
      expect(result.tss).toBeCloseTo(85.5);
    });

    it("handles missing workout summary gracefully", () => {
      const workoutNoSummary: WahooWorkout = {
        ...sampleWorkout,
        workout_summary: undefined,
      };

      const result = parseWorkoutSummary(workoutNoSummary);

      expect(result.externalId).toBe("42");
      expect(result.activityType).toBe("cycling");
      expect(result.durationSeconds).toBeUndefined();
      expect(result.avgHeartRate).toBeUndefined();
    });

    it("maps workout_type_id to activity type", () => {
      expect(parseWorkoutSummary({ ...sampleWorkout, workout_type_id: 0 }).activityType).toBe(
        "cycling",
      );
      expect(parseWorkoutSummary({ ...sampleWorkout, workout_type_id: 1 }).activityType).toBe(
        "running",
      );
      expect(parseWorkoutSummary({ ...sampleWorkout, workout_type_id: 2 }).activityType).toBe(
        "running",
      );
      expect(parseWorkoutSummary({ ...sampleWorkout, workout_type_id: 8 }).activityType).toBe(
        "walking",
      );
      expect(parseWorkoutSummary({ ...sampleWorkout, workout_type_id: 99 }).activityType).toBe(
        "other",
      );
    });
  });

  describe("parseWorkoutList", () => {
    it("parses a paginated workout response", () => {
      const response = {
        workouts: [sampleWorkout],
        total: 50,
        page: 1,
        per_page: 30,
        order: "descending",
        sort: "starts",
      };

      const result = parseWorkoutList(response);

      expect(result.workouts).toHaveLength(1);
      expect(result.total).toBe(50);
      expect(result.page).toBe(1);
      expect(result.perPage).toBe(30);
      expect(result.hasMore).toBe(true);
    });

    it("detects last page", () => {
      const response = {
        workouts: [sampleWorkout],
        total: 1,
        page: 1,
        per_page: 30,
        order: "descending",
        sort: "starts",
      };

      const result = parseWorkoutList(response);

      expect(result.hasMore).toBe(false);
    });
  });
});
