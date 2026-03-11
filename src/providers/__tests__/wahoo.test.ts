import { describe, expect, it } from "vitest";
import type { ParsedFitRecord } from "../../fit/parser.ts";
import {
  fitRecordsToMetricStream,
  parseWorkoutList,
  parseWorkoutSummary,
  type WahooWorkout,
  type WahooWorkoutSummary,
} from "../wahoo.ts";

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
    });

    it("handles missing workout summary gracefully", () => {
      const workoutNoSummary: WahooWorkout = {
        ...sampleWorkout,
        workout_summary: undefined,
      };

      const result = parseWorkoutSummary(workoutNoSummary);

      expect(result.externalId).toBe("42");
      expect(result.activityType).toBe("cycling");
      expect(result.endedAt).toBeUndefined();
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

  describe("fitRecordsToMetricStream", () => {
    const fakeRecords: ParsedFitRecord[] = [
      {
        recordedAt: new Date("2026-03-01T10:00:00Z"),
        heartRate: 130,
        power: 200,
        cadence: 85,
        speed: 8.5,
        lat: 40.7128,
        lng: -74.006,
        altitude: 15.2,
        temperature: 22,
        distance: 100,
        raw: { timestamp: "2026-03-01T10:00:00Z", heart_rate: 130, power: 200 },
      },
      {
        recordedAt: new Date("2026-03-01T10:00:05Z"),
        heartRate: 135,
        power: 210,
        cadence: 88,
        speed: 8.7,
        lat: 40.7129,
        lng: -74.0059,
        altitude: 15.5,
        temperature: 22,
        distance: 143,
        verticalOscillation: 9.2,
        stanceTime: 240,
        raw: { timestamp: "2026-03-01T10:00:05Z", heart_rate: 135, power: 210 },
      },
    ];

    it("maps FIT records to metric_stream insert rows", () => {
      const rows = fitRecordsToMetricStream(fakeRecords, "wahoo", "activity-uuid-123");
      expect(rows).toHaveLength(2);

      expect(rows[0].providerId).toBe("wahoo");
      expect(rows[0].activityId).toBe("activity-uuid-123");
      expect(rows[0].recordedAt).toEqual(new Date("2026-03-01T10:00:00Z"));
      expect(rows[0].heartRate).toBe(130);
      expect(rows[0].power).toBe(200);
      expect(rows[0].cadence).toBe(85);
      expect(rows[0].speed).toBe(8.5);
      expect(rows[0].lat).toBe(40.7128);
      expect(rows[0].lng).toBe(-74.006);
      expect(rows[0].altitude).toBe(15.2);
      expect(rows[0].temperature).toBe(22);
      expect(rows[0].distance).toBe(100);
    });

    it("includes running dynamics when present", () => {
      const rows = fitRecordsToMetricStream(fakeRecords, "wahoo", "activity-uuid-123");
      expect(rows[1].verticalOscillation).toBe(9.2);
      expect(rows[1].stanceTime).toBe(240);
    });

    it("includes raw JSONB for every record", () => {
      const rows = fitRecordsToMetricStream(fakeRecords, "wahoo", "activity-uuid-123");
      expect(rows[0].raw).toEqual({
        timestamp: "2026-03-01T10:00:00Z",
        heart_rate: 130,
        power: 200,
      });
    });

    it("handles empty records array", () => {
      const rows = fitRecordsToMetricStream([], "wahoo", "activity-uuid-123");
      expect(rows).toHaveLength(0);
    });
  });
});
