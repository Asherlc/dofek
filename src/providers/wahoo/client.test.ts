import { describe, expect, it } from "vitest";
import { AccessTokenExpiredError, ProviderAuthenticationFailedError } from "../auth-errors.ts";
import {
  createWahooNumeric,
  createWahooSingleWorkoutResponseSchema,
  createWahooWebhookPayloadSchema,
  createWahooWorkoutListResponseSchema,
  createWahooWorkoutSchema,
  createWahooWorkoutSummarySchema,
  WahooApiError,
  WahooClient,
} from "./client.ts";

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

async function expectRejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      return error;
    }
  }
  throw new Error("Expected promise to reject");
}

describe("Wahoo schemas", () => {
  describe("wahooNumeric", () => {
    it("coerces string to number", () => {
      const schema = createWahooNumeric();
      expect(schema.parse("42")).toBe(42);
    });

    it("coerces null to undefined", () => {
      const schema = createWahooNumeric();
      expect(schema.parse(null)).toBeUndefined();
    });

    it("passes through a number unchanged", () => {
      const schema = createWahooNumeric();
      expect(schema.parse(99)).toBe(99);
    });
  });

  describe("wahooWorkoutSummarySchema", () => {
    it("parses valid summary and coerces string numerics", () => {
      const schema = createWahooWorkoutSummarySchema();
      const result = schema.parse(validSummary);
      expect(result.id).toBe(1);
      expect(result.ascent_accum).toBe(100);
      expect(result.heart_rate_avg).toBe(140);
      expect(result.file?.url).toBe("https://cdn.wahoo.com/file.fit");
    });

    it("coerces null numeric fields to undefined", () => {
      const schema = createWahooWorkoutSummarySchema();
      const result = schema.parse({
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
      const schema = createWahooWorkoutSchema();
      const result = schema.parse(validWorkout);
      expect(result.id).toBe(42);
      expect(result.workout_type_id).toBe(1);
      expect(result.starts).toBe("2025-01-01T06:00:00Z");
      expect(result.workout_summary?.id).toBe(1);
    });

    it("rejects workout missing required workout_type_id", () => {
      const schema = createWahooWorkoutSchema();
      const { workout_type_id: _, ...missing } = validWorkout;
      expect(() => schema.parse(missing)).toThrow();
    });

    it("accepts workout_summary when null", () => {
      const schema = createWahooWorkoutSchema();
      const result = schema.parse({
        ...validWorkout,
        workout_summary: null,
      });
      expect(result.workout_summary).toBeUndefined();
    });
  });

  describe("wahooWorkoutListResponseSchema", () => {
    it("parses valid list response", () => {
      const schema = createWahooWorkoutListResponseSchema();
      const result = schema.parse({
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

    it("accepts workout summaries with a null file URL", () => {
      const schema = createWahooWorkoutListResponseSchema();
      const result = schema.parse({
        workouts: [
          {
            ...validWorkout,
            workout_summary: {
              ...validSummary,
              file: { url: null },
            },
          },
        ],
        total: 1,
        page: 1,
        per_page: 20,
        order: "descending",
        sort: "created_at",
      });

      expect(result.workouts[0]?.workout_summary?.file?.url).toBeUndefined();
    });
  });

  describe("wahooSingleWorkoutResponseSchema", () => {
    it("parses wrapped workout response", () => {
      const schema = createWahooSingleWorkoutResponseSchema();
      const result = schema.parse({ workout: validWorkout });
      expect(result.workout.id).toBe(42);
    });
  });

  describe("wahooWebhookPayloadSchema", () => {
    it("parses webhook payload with user and workout data", () => {
      const schema = createWahooWebhookPayloadSchema();
      const result = schema.parse({
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
      const schema = createWahooWebhookPayloadSchema();
      expect(() => schema.parse({ event_type: "test" })).toThrow();
    });
  });
});

describe("WahooClient", () => {
  it("throws an access token expired error for Wahoo's expired token response", async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({ error: "Access token has expired" }), { status: 401 });
    const client = new WahooClient("expired-token", fetchFn);

    await expect(client.getWorkouts()).rejects.toBeInstanceOf(AccessTokenExpiredError);
  });

  it("throws an authentication failure for Wahoo's empty 401 response", async () => {
    const fetchFn = async () => new Response("", { status: 401 });
    const client = new WahooClient("expired-token", fetchFn);

    const error = await expectRejectedError(client.getWorkouts());

    expect(error).toBeInstanceOf(ProviderAuthenticationFailedError);
    expect(error.cause).toBeInstanceOf(WahooApiError);
    if (error.cause instanceof WahooApiError) {
      expect(error.cause.responseBodyExcerpt).toBe("(empty response body)");
    }
  });

  it("throws an authentication failure for Wahoo's whitespace-only 401 response", async () => {
    const fetchFn = async () => new Response(" \n\t ", { status: 401 });
    const client = new WahooClient("expired-token", fetchFn);

    const error = await expectRejectedError(client.getWorkouts());

    expect(error).toBeInstanceOf(ProviderAuthenticationFailedError);
    expect(error.cause).toBeInstanceOf(WahooApiError);
    if (error.cause instanceof WahooApiError) {
      expect(error.cause.responseBodyExcerpt).toBe("(empty response body)");
    }
  });

  it("does not classify empty non-401 Wahoo failures as authentication failures", async () => {
    const fetchFn = async () => new Response("", { status: 500 });
    const client = new WahooClient("token", fetchFn);

    const error = await expectRejectedError(client.getWorkouts());

    expect(error).toBeInstanceOf(WahooApiError);
    expect(error).not.toBeInstanceOf(ProviderAuthenticationFailedError);
    if (error instanceof WahooApiError) {
      expect(error.responseBodyExcerpt).toBe("(empty response body)");
    }
  });

  it("throws a typed API error for non-auth Wahoo failures", async () => {
    const fetchFn = async () => new Response("server error", { status: 500 });
    const client = new WahooClient("token", fetchFn);

    const error = await expectRejectedError(client.getWorkouts());

    expect(error).toMatchObject({
      statusCode: 500,
      path: "/v1/workouts",
      responseBodyExcerpt: "server error",
    });
    expect(error).toBeInstanceOf(WahooApiError);
  });

  it("does not truncate Wahoo API error bodies at the excerpt limit", async () => {
    const responseBody = "a".repeat(200);
    const fetchFn = async () => new Response(responseBody, { status: 500 });
    const client = new WahooClient("token", fetchFn);

    const error = await expectRejectedError(client.getWorkouts());

    expect(error).toBeInstanceOf(WahooApiError);
    if (error instanceof WahooApiError) {
      expect(error.responseBodyExcerpt).toBe(responseBody);
    }
  });

  it("truncates Wahoo API error bodies over the excerpt limit", async () => {
    const responseBody = `${"a".repeat(200)}b`;
    const fetchFn = async () => new Response(responseBody, { status: 500 });
    const client = new WahooClient("token", fetchFn);

    const error = await expectRejectedError(client.getWorkouts());

    expect(error).toBeInstanceOf(WahooApiError);
    if (error instanceof WahooApiError) {
      expect(error.responseBodyExcerpt).toBe(`${"a".repeat(200)}…`);
    }
  });
});
