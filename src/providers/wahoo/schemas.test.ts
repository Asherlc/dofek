import { describe, expect, it } from "vitest";
import {
  wahooSingleWorkoutResponseSchema,
  wahooWebhookPayloadSchema,
  wahooWorkoutListResponseSchema,
  wahooWorkoutSchema,
  wahooWorkoutSummarySchema,
} from "./schemas.ts";

const validSummary = {
  id: 1,
  ascent_accum: "100",
  cadence_avg: "80",
  calories_accum: "500",
  distance_accum: "10000",
  duration_active_accum: "3600",
  duration_paused_accum: "60",
  duration_total_accum: "3660",
  heart_rate_avg: "140",
  power_bike_np_last: "200",
  power_bike_tss_last: "50",
  power_avg: "190",
  speed_avg: "25",
  work_accum: "600",
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T01:00:00Z",
  file: { url: "https://cdn.wahoo.com/file.fit" },
};

const validWorkout = {
  id: 42,
  name: "Morning Ride",
  workout_token: "abc123",
  workout_type_id: 1,
  starts: "2025-01-01T06:00:00Z",
  minutes: 60,
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T01:00:00Z",
  workout_summary: validSummary,
};

describe("Wahoo schemas", () => {
  describe("wahooWorkoutSummarySchema", () => {
    it("parses valid summary and coerces string numerics", () => {
      const result = wahooWorkoutSummarySchema.parse(validSummary);
      expect(result.id).toBe(1);
      expect(result.ascent_accum).toBe(100);
      expect(result.heart_rate_avg).toBe(140);
      expect(result.file?.url).toBe("https://cdn.wahoo.com/file.fit");
    });

    it("coerces null numeric fields to undefined", () => {
      const result = wahooWorkoutSummarySchema.parse({
        ...validSummary,
        power_avg: null,
        cadence_avg: null,
      });
      expect(result.power_avg).toBeUndefined();
      expect(result.cadence_avg).toBeUndefined();
    });
  });

  describe("wahooWorkoutSchema", () => {
    it("parses valid workout with required fields", () => {
      const result = wahooWorkoutSchema.parse(validWorkout);
      expect(result.id).toBe(42);
      expect(result.workout_type_id).toBe(1);
      expect(result.starts).toBe("2025-01-01T06:00:00Z");
      expect(result.workout_summary?.id).toBe(1);
    });

    it("rejects workout missing required workout_type_id", () => {
      const { workout_type_id: _, ...missing } = validWorkout;
      expect(() => wahooWorkoutSchema.parse(missing)).toThrow();
    });
  });

  describe("wahooWorkoutListResponseSchema", () => {
    it("parses valid list response", () => {
      const result = wahooWorkoutListResponseSchema.parse({
        workouts: [validWorkout],
        total: 1,
        page: 1,
        per_page: 20,
        order: "descending",
        sort: "created_at",
      });
      expect(result.workouts).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.per_page).toBe(20);
      expect(result.order).toBe("descending");
      expect(result.sort).toBe("created_at");
    });
  });

  describe("wahooSingleWorkoutResponseSchema", () => {
    it("parses wrapped workout response", () => {
      const result = wahooSingleWorkoutResponseSchema.parse({ workout: validWorkout });
      expect(result.workout.id).toBe(42);
    });
  });

  describe("wahooWebhookPayloadSchema", () => {
    it("parses webhook payload with user and workout data", () => {
      const result = wahooWebhookPayloadSchema.parse({
        event_type: "workout_summary.updated",
        webhook_token: "tok123",
        user: { id: 99 },
        workout_summary: validSummary,
        workout: validWorkout,
      });
      expect(result.user.id).toBe(99);
      expect(result.workout?.id).toBe(42);
      expect(result.workout_summary?.id).toBe(1);
    });

    it("rejects payload missing required user field", () => {
      expect(() => wahooWebhookPayloadSchema.parse({ event_type: "test" })).toThrow();
    });
  });
});
