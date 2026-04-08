import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import * as resolveTokensModule from "../auth/resolve-tokens.ts";
import * as sensorSampleWriterModule from "../db/sensor-sample-writer.ts";
import type { ParsedFitRecord, ParsedFitSession } from "../fit/parser.ts";
import * as fitParserModule from "../fit/parser.ts";
import { fitRecordsToSensorSamples as fitRecordsToMetricStream } from "../fit/records.ts";
import * as loggerModule from "../logger.ts";
import { WahooClient, type WahooWorkout, type WahooWorkoutSummary } from "./wahoo/client.ts";
import { parseWorkoutList, parseWorkoutSummary } from "./wahoo/parsers.ts";
import { WahooProvider, wahooOAuthConfig } from "./wahoo/provider.ts";

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

const sampleParsedFitSession: ParsedFitSession = {
  sport: "cycling",
  startTime: new Date("2026-03-01T08:00:00Z"),
  totalElapsedTime: 3600,
  totalTimerTime: 3600,
  totalDistance: 100,
  totalCalories: 500,
  raw: {},
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

    it("treats zero duration_total_accum as falsy (no endedAt)", () => {
      const workout: WahooWorkout = {
        ...sampleWorkout,
        workout_summary: {
          ...sampleWorkoutSummary,
          duration_total_accum: 0,
        },
      };

      const result = parseWorkoutSummary(workout);
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

    it("returns hasMore=false when page*perPage equals total exactly", () => {
      const response = {
        workouts: [sampleWorkout],
        total: 30,
        page: 1,
        per_page: 30,
        order: "descending" as const,
        sort: "starts" as const,
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

      expect(rows[0]?.providerId).toBe("wahoo");
      expect(rows[0]?.activityId).toBe("activity-uuid-123");
      expect(rows[0]?.recordedAt).toEqual(new Date("2026-03-01T10:00:00Z"));
      expect(rows[0]?.heartRate).toBe(130);
      expect(rows[0]?.power).toBe(200);
      expect(rows[0]?.cadence).toBe(85);
      expect(rows[0]?.speed).toBe(8.5);
      expect(rows[0]?.lat).toBe(40.7128);
      expect(rows[0]?.lng).toBe(-74.006);
      expect(rows[0]?.altitude).toBe(15.2);
      expect(rows[0]?.temperature).toBe(22);
    });

    it("includes running dynamics when present", () => {
      const rows = fitRecordsToMetricStream(fakeRecords, "wahoo", "activity-uuid-123");
      expect(rows[1]?.verticalOscillation).toBe(9.2);
      expect(rows[1]?.stanceTime).toBe(240);
    });

    it("includes raw JSONB for every record", () => {
      const rows = fitRecordsToMetricStream(fakeRecords, "wahoo", "activity-uuid-123");
      expect(rows[0]?.raw).toEqual({
        timestamp: "2026-03-01T10:00:00Z",
        heart_rate: 130,
        power: 200,
      });
    });

    it("handles empty records array", () => {
      const rows = fitRecordsToMetricStream([], "wahoo", "activity-uuid-123");
      expect(rows).toHaveLength(0);
    });

    it("omits speed for indoor_cycling activities", () => {
      const rows = fitRecordsToMetricStream(
        fakeRecords,
        "wahoo",
        "activity-uuid-123",
        "indoor_cycling",
      );
      expect(rows[0]?.speed).toBeUndefined();
      expect(rows[1]?.speed).toBeUndefined();
      // Other fields should still be present
      expect(rows[0]?.heartRate).toBe(130);
      expect(rows[0]?.power).toBe(200);
    });

    it("omits speed for virtual_cycling activities", () => {
      const rows = fitRecordsToMetricStream(
        fakeRecords,
        "wahoo",
        "activity-uuid-123",
        "virtual_cycling",
      );
      expect(rows[0]?.speed).toBeUndefined();
    });

    it("keeps speed for outdoor cycling activities", () => {
      const rows = fitRecordsToMetricStream(
        fakeRecords,
        "wahoo",
        "activity-uuid-123",
        "road_cycling",
      );
      expect(rows[0]?.speed).toBe(8.5);
    });
  });
});

// ============================================================
// Auth, validation, and client tests (merged from wahoo-coverage)
// ============================================================

describe("wahooOAuthConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when WAHOO_CLIENT_ID is not set", () => {
    delete process.env.WAHOO_CLIENT_ID;
    delete process.env.WAHOO_CLIENT_SECRET;
    expect(wahooOAuthConfig()).toBeNull();
  });

  it("returns null when WAHOO_CLIENT_SECRET is not set", () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    delete process.env.WAHOO_CLIENT_SECRET;
    expect(wahooOAuthConfig()).toBeNull();
  });

  it("returns config when both env vars are set", () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";
    const config = wahooOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toContain("email");
    expect(config?.scopes).toContain("workouts_read");
  });

  it("uses custom OAUTH_REDIRECT_URI when set", () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI = "https://example.com/callback";
    const config = wahooOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");
  });

  it("uses default redirect URI when OAUTH_REDIRECT_URI is not set", () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";
    delete process.env.OAUTH_REDIRECT_URI;
    const config = wahooOAuthConfig();
    expect(config?.redirectUri).toBe("https://dofek.asherlc.com/callback");
  });
});

describe("WahooProvider.validate()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns error when WAHOO_CLIENT_ID is missing", () => {
    delete process.env.WAHOO_CLIENT_ID;
    delete process.env.WAHOO_CLIENT_SECRET;
    const provider = new WahooProvider();
    expect(provider.validate()).toContain("WAHOO_CLIENT_ID");
  });

  it("returns error when WAHOO_CLIENT_SECRET is missing", () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    delete process.env.WAHOO_CLIENT_SECRET;
    const provider = new WahooProvider();
    expect(provider.validate()).toContain("WAHOO_CLIENT_SECRET");
  });

  it("returns null when both are set", () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";
    const provider = new WahooProvider();
    expect(provider.validate()).toBeNull();
  });
});

describe("WahooProvider.authSetup()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns auth setup with OAuth config", () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";
    const provider = new WahooProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.clientId).toBe("test-id");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.revokeExistingTokens).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toBe("https://api.wahooligan.com");
    expect(setup.identityCapabilities?.providesEmail).toBe(false);
  });

  it("deauthorizes existing Wahoo authorization via DELETE /v1/permissions", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    let capturedUrl = "";
    let capturedMethod = "";
    let capturedHeaders: HeadersInit | undefined;
    const mockFetch: typeof globalThis.fetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedUrl = String(input);
      capturedMethod = init?.method ?? "GET";
      capturedHeaders = init?.headers;
      return new Response(null, { status: 204 });
    };

    const provider = new WahooProvider(mockFetch);
    const setup = provider.authSetup();
    if (!setup.revokeExistingTokens) {
      throw new Error("Expected revokeExistingTokens to be defined");
    }

    await setup.revokeExistingTokens({
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
      expiresAt: new Date("2027-01-01"),
      scopes: "user_read workouts_read",
    });

    expect(capturedUrl).toBe("https://api.wahooligan.com/v1/permissions");
    expect(capturedMethod).toBe("DELETE");
    expect(capturedHeaders).toEqual(
      expect.objectContaining({ Authorization: "Bearer old-access-token" }),
    );
  });

  it("throws when env vars are missing", () => {
    delete process.env.WAHOO_CLIENT_ID;
    delete process.env.WAHOO_CLIENT_SECRET;
    const provider = new WahooProvider();
    expect(() => provider.authSetup()).toThrow("WAHOO_CLIENT_ID");
  });
});

describe("WahooClient — API base URL", () => {
  it("uses https://api.wahooligan.com as the base URL for workouts endpoint", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (
      input: string | URL | Request,
    ): Promise<Response> => {
      capturedUrl = String(input);
      return Response.json({
        workouts: [],
        total: 0,
        page: 1,
        per_page: 30,
        order: "desc",
        sort: "starts",
      });
    };

    const client = new WahooClient("token", mockFetch);
    await client.getWorkouts();
    expect(capturedUrl).toMatch(/^https:\/\/api\.wahooligan\.com\//);
    expect(capturedUrl).toContain("/v1/workouts");
  });

  it("sends Authorization Bearer header with access token", async () => {
    let capturedHeaders: HeadersInit | undefined;
    const mockFetch: typeof globalThis.fetch = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedHeaders = init?.headers;
      return Response.json({
        workouts: [],
        total: 0,
        page: 1,
        per_page: 30,
        order: "desc",
        sort: "starts",
      });
    };

    const client = new WahooClient("my-token", mockFetch);
    await client.getWorkouts();
    expect(capturedHeaders).toEqual(expect.objectContaining({ Authorization: "Bearer my-token" }));
  });
});

describe("WahooClient — error handling", () => {
  it("throws on non-OK response from workouts endpoint", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Unauthorized", { status: 401 });
    };

    const client = new WahooClient("bad-token", mockFetch);
    await expect(client.getWorkouts()).rejects.toThrow("API error 401 on /v1/workouts");
  });

  it("does not send auth headers when downloading FIT files", async () => {
    let capturedHeaders: HeadersInit | undefined;
    const mockFetch: typeof globalThis.fetch = async (_url, init): Promise<Response> => {
      capturedHeaders = init?.headers;
      return new Response(new ArrayBuffer(8));
    };

    const client = new WahooClient("secret-token", mockFetch);
    await client.downloadFitFile("https://cdn.wahoo.com/presigned-file.fit");
    expect(capturedHeaders).toBeUndefined();
  });

  it("throws on FIT file download failure", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Not Found", { status: 404 });
    };

    const client = new WahooClient("token", mockFetch);
    await expect(client.downloadFitFile("https://example.com/test.fit")).rejects.toThrow(
      "Failed to download FIT file (404)",
    );
  });
});

describe("WahooClient — Zod coercion of string/null numeric fields", () => {
  it("coerces string numeric fields and null values from the Wahoo API", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({
        workouts: [
          {
            id: 1,
            workout_type_id: 0,
            starts: "2026-03-01T10:00:00Z",
            created_at: "2026-03-01T10:00:00Z",
            updated_at: "2026-03-01T10:00:00Z",
            workout_summary: {
              id: 101,
              ascent_accum: "350.5",
              cadence_avg: null,
              calories_accum: "1500",
              distance_accum: "42000.0",
              duration_active_accum: "5400",
              duration_paused_accum: "120",
              duration_total_accum: "5520",
              heart_rate_avg: "145.3",
              power_bike_np_last: null,
              power_bike_tss_last: null,
              power_avg: null,
              speed_avg: "7.78",
              work_accum: null,
              created_at: "2026-03-01T10:00:00Z",
              updated_at: "2026-03-01T10:30:00Z",
            },
          },
        ],
        total: 1,
        page: 1,
        per_page: 30,
        order: "desc",
        sort: "starts",
      });
    };

    const client = new WahooClient("token", mockFetch);
    const result = await client.getWorkouts();
    const summary = result.workouts[0]?.workout_summary;

    expect(summary?.ascent_accum).toBe(350.5);
    expect(summary?.cadence_avg).toBeUndefined();
    expect(summary?.calories_accum).toBe(1500);
    expect(summary?.distance_accum).toBe(42000.0);
    expect(summary?.duration_active_accum).toBe(5400);
    expect(summary?.heart_rate_avg).toBe(145.3);
    expect(summary?.power_bike_np_last).toBeUndefined();
    expect(summary?.power_avg).toBeUndefined();
    expect(summary?.speed_avg).toBe(7.78);
    expect(summary?.work_accum).toBeUndefined();
  });
});

describe("WahooClient — Zod runtime validation", () => {
  it("rejects a workout list response with missing required fields", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({ workouts: "not-an-array" });
    };

    const client = new WahooClient("token", mockFetch);
    await expect(client.getWorkouts()).rejects.toThrow(ZodError);
  });

  it("rejects a single workout response with wrong shape", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({ workout: { id: "not-a-number" } });
    };

    const client = new WahooClient("token", mockFetch);
    await expect(client.getWorkout(42)).rejects.toThrow(ZodError);
  });

  it("validates and returns a correct workout list response", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({
        workouts: [
          {
            id: 1,
            workout_type_id: 0,
            starts: "2026-03-01T10:00:00Z",
            created_at: "2026-03-01T10:00:00Z",
            updated_at: "2026-03-01T10:00:00Z",
          },
        ],
        total: 1,
        page: 1,
        per_page: 30,
        order: "desc",
        sort: "starts",
      });
    };

    const client = new WahooClient("token", mockFetch);
    const result = await client.getWorkouts();
    expect(result.workouts).toHaveLength(1);
    expect(result.workouts[0]?.id).toBe(1);
    expect(result.total).toBe(1);
  });
});

describe("parseWorkoutSummary — additional type mappings", () => {
  const baseWorkout: WahooWorkout = {
    id: 100,
    workout_type_id: 0,
    starts: "2026-03-01T10:00:00Z",
    created_at: "2026-03-01T10:00:00Z",
    updated_at: "2026-03-01T11:00:00Z",
  };

  it("maps swimming type", () => {
    expect(parseWorkoutSummary({ ...baseWorkout, workout_type_id: 6 }).activityType).toBe(
      "swimming",
    );
  });

  it("maps yoga type", () => {
    expect(parseWorkoutSummary({ ...baseWorkout, workout_type_id: 7 }).activityType).toBe("yoga");
  });

  it("maps hiking type", () => {
    expect(parseWorkoutSummary({ ...baseWorkout, workout_type_id: 9 }).activityType).toBe("hiking");
  });

  it("maps rowing type", () => {
    expect(parseWorkoutSummary({ ...baseWorkout, workout_type_id: 10 }).activityType).toBe(
      "rowing",
    );
  });

  it("maps strength type", () => {
    expect(parseWorkoutSummary({ ...baseWorkout, workout_type_id: 11 }).activityType).toBe(
      "strength",
    );
  });

  it("maps elliptical type", () => {
    expect(parseWorkoutSummary({ ...baseWorkout, workout_type_id: 12 }).activityType).toBe(
      "elliptical",
    );
  });

  it("maps skiing type", () => {
    expect(parseWorkoutSummary({ ...baseWorkout, workout_type_id: 13 }).activityType).toBe(
      "skiing",
    );
  });

  it("computes endedAt from starts + duration_total_accum", () => {
    const workout: WahooWorkout = {
      ...baseWorkout,
      workout_summary: {
        id: 200,
        duration_total_accum: 3600,
        created_at: "2026-03-01T11:00:00Z",
        updated_at: "2026-03-01T11:00:00Z",
      },
    };
    const result = parseWorkoutSummary(workout);
    expect(result.endedAt).toEqual(
      new Date(new Date("2026-03-01T10:00:00Z").getTime() + 3600 * 1000),
    );
  });

  it("includes fitFileUrl from summary", () => {
    const workout: WahooWorkout = {
      ...baseWorkout,
      workout_summary: {
        id: 200,
        created_at: "2026-03-01T11:00:00Z",
        updated_at: "2026-03-01T11:00:00Z",
        file: { url: "https://cdn.wahoo.com/test.fit" },
      },
    };
    const result = parseWorkoutSummary(workout);
    expect(result.fitFileUrl).toBe("https://cdn.wahoo.com/test.fit");
  });

  it("uses workout name when provided", () => {
    const workout: WahooWorkout = {
      ...baseWorkout,
      name: "Hill Repeats",
    };
    const result = parseWorkoutSummary(workout);
    expect(result.name).toBe("Hill Repeats");
  });

  it("handles indoor cycling type (3)", () => {
    expect(parseWorkoutSummary({ ...baseWorkout, workout_type_id: 3 }).activityType).toBe(
      "indoor_cycling",
    );
  });

  it("handles mountain biking type (4)", () => {
    expect(parseWorkoutSummary({ ...baseWorkout, workout_type_id: 4 }).activityType).toBe(
      "mountain_biking",
    );
  });

  it("handles gravel cycling type (5)", () => {
    expect(parseWorkoutSummary({ ...baseWorkout, workout_type_id: 5 }).activityType).toBe(
      "gravel_cycling",
    );
  });
});

describe("WahooProvider.getUserIdentity()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns identity from user API without relying on email", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({
        id: 42,
        email: "user@wahoo.com",
        first_name: "John",
        last_name: "Smith",
      });
    };

    const provider = new WahooProvider(mockFetch);
    const setup = provider.authSetup();
    if (!setup.getUserIdentity) throw new Error("getUserIdentity not defined");
    const identity = await setup.getUserIdentity("test-token");
    expect(identity.providerAccountId).toBe("42");
    expect(identity.email).toBeNull();
    expect(identity.name).toBe("John Smith");
  });

  it("handles missing name/email", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({ id: 7 });
    };

    const provider = new WahooProvider(mockFetch);
    const setup = provider.authSetup();
    if (!setup.getUserIdentity) throw new Error("getUserIdentity not defined");
    const identity = await setup.getUserIdentity("test-token");
    expect(identity.providerAccountId).toBe("7");
    expect(identity.email).toBeNull();
    expect(identity.name).toBeNull();
  });

  it("throws on API error", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Unauthorized", { status: 401 });
    };

    const provider = new WahooProvider(mockFetch);
    const setup = provider.authSetup();
    if (!setup.getUserIdentity) throw new Error("getUserIdentity not defined");
    await expect(setup.getUserIdentity("bad-token")).rejects.toThrow("Wahoo user API error (401)");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================
// syncWebhookEvent tests
// ============================================================

function makeWahooInsertMock(returnId = "act-uuid") {
  return vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: returnId }]),
      }),
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    }),
  });
}

describe("WahooProvider.syncWebhookEvent", () => {
  it("returns immediately for non-workout objectType", async () => {
    const provider = new WahooProvider(async () => new Response());
    const mockDb = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
    };

    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "42",
      eventType: "create",
      objectType: "user",
      objectId: "1",
    });

    expect(result.provider).toBe("wahoo");
    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns error when webhook metadata is invalid", async () => {
    const provider = new WahooProvider(async () => new Response());
    const mockDb = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
    };

    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "42",
      eventType: "create",
      objectType: "workout",
      objectId: "99",
      metadata: { payload: { bad: "data" } },
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("Invalid webhook payload");
  });

  it("returns early when payload has workout_summary but no workout", async () => {
    const provider = new WahooProvider(async () => new Response());
    const mockDb = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
    };

    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "42",
      eventType: "create",
      objectType: "workout",
      objectId: "99",
      metadata: {
        payload: {
          user: { id: 42 },
          workout_summary: {
            id: 99,
            created_at: "2026-03-01T10:00:00Z",
            updated_at: "2026-03-01T10:00:00Z",
          },
        },
      },
    });

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns error when payload has neither workout nor workout_summary", async () => {
    const provider = new WahooProvider(async () => new Response());
    const mockDb = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
    };

    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "42",
      eventType: "create",
      objectType: "workout",
      objectId: "99",
      metadata: {
        payload: {
          user: { id: 42 },
        },
      },
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("missing workout data");
  });

  it("upserts activity on happy path without FIT file", async () => {
    const mockInsert = makeWahooInsertMock();
    const mockDb = {
      select: vi.fn(),
      insert: mockInsert,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn(),
    };

    const provider = new WahooProvider(async () => new Response());
    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "42",
      eventType: "create",
      objectType: "workout",
      objectId: "99",
      metadata: {
        payload: {
          user: { id: 42 },
          workout: {
            id: 42,
            workout_type_id: 0,
            starts: "2026-03-01T08:00:00Z",
            created_at: "2026-03-01T10:00:00Z",
            updated_at: "2026-03-01T10:00:00Z",
          },
        },
      },
    });

    expect(result.provider).toBe("wahoo");
    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(mockInsert).toHaveBeenCalled();
  });

  it("merges standalone workout_summary into workout when workout has none", async () => {
    const mockInsert = makeWahooInsertMock();
    const mockDb = {
      select: vi.fn(),
      insert: mockInsert,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn(),
    };

    const provider = new WahooProvider(async () => new Response());
    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "42",
      eventType: "create",
      objectType: "workout",
      objectId: "99",
      metadata: {
        payload: {
          user: { id: 42 },
          workout_summary: {
            id: 200,
            duration_total_accum: 3600,
            created_at: "2026-03-01T11:00:00Z",
            updated_at: "2026-03-01T11:00:00Z",
          },
          workout: {
            id: 42,
            workout_type_id: 0,
            starts: "2026-03-01T08:00:00Z",
            created_at: "2026-03-01T10:00:00Z",
            updated_at: "2026-03-01T10:00:00Z",
            // No workout_summary here — should be merged from top-level
          },
        },
      },
    });

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("collects FIT file download errors without failing", async () => {
    const mockInsert = makeWahooInsertMock();
    const mockDelete = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    const mockDb = {
      select: vi.fn(),
      insert: mockInsert,
      delete: mockDelete,
      execute: vi.fn(),
    };

    // FIT file URL download returns 404
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Not Found", { status: 404 });
    };

    const provider = new WahooProvider(mockFetch);
    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "42",
      eventType: "create",
      objectType: "workout",
      objectId: "99",
      metadata: {
        payload: {
          user: { id: 42 },
          workout: {
            id: 42,
            workout_type_id: 0,
            starts: "2026-03-01T08:00:00Z",
            created_at: "2026-03-01T10:00:00Z",
            updated_at: "2026-03-01T10:00:00Z",
            workout_summary: {
              id: 101,
              created_at: "2026-03-01T10:00:00Z",
              updated_at: "2026-03-01T10:00:00Z",
              file: { url: "https://cdn.wahoo.com/test.fit" },
            },
          },
        },
      },
    });

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("FIT file");
  });

  it("writes sensor samples for FIT webhook payloads after clearing prior activity rows", async () => {
    vi.spyOn(fitParserModule, "parseFitFile").mockResolvedValue({
      session: sampleParsedFitSession,
      records: [
        {
          recordedAt: new Date("2026-03-01T08:00:00Z"),
          heartRate: 145,
          power: 210,
          cadence: 88,
          speed: 8.5,
          distance: 100,
          raw: { heart_rate: 145, power: 210 },
        },
      ],
      laps: [],
      events: [],
    });
    const dualWriteSpy = vi
      .spyOn(sensorSampleWriterModule, "dualWriteToSensorSample")
      .mockResolvedValue(0);
    const loggerInfoSpy = vi
      .spyOn(loggerModule.logger, "info")
      .mockImplementation(() => loggerModule.logger);
    const whereSpy = vi.fn().mockResolvedValue(undefined);
    const mockDb = {
      select: vi.fn(),
      insert: makeWahooInsertMock(),
      delete: vi.fn().mockReturnValue({ where: whereSpy }),
      execute: vi.fn(),
    };
    const provider = new WahooProvider(async (input): Promise<Response> => {
      if (String(input) === "https://cdn.wahoo.com/test.fit") {
        return new Response(new Uint8Array([1, 2, 3]));
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.spyOn(fitParserModule, "parseFitFile").mockResolvedValue({
      session: sampleParsedFitSession,
      records: [
        {
          recordedAt: new Date("2026-03-01T08:00:00Z"),
          heartRate: 145,
          power: 210,
          cadence: 88,
          speed: 8.5,
          distance: 100,
          raw: { heart_rate: 145, power: 210 },
        },
      ],
      laps: [],
      events: [],
    });

    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "42",
      eventType: "create",
      objectType: "workout",
      objectId: "99",
      metadata: {
        payload: {
          user: { id: 42 },
          workout: {
            id: 42,
            workout_type_id: 0,
            starts: "2026-03-01T08:00:00Z",
            created_at: "2026-03-01T10:00:00Z",
            updated_at: "2026-03-01T10:00:00Z",
            workout_summary: {
              id: 101,
              created_at: "2026-03-01T10:00:00Z",
              updated_at: "2026-03-01T10:00:00Z",
              file: { url: "https://cdn.wahoo.com/test.fit" },
            },
          },
        },
      },
    });

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(whereSpy).toHaveBeenCalledTimes(1);
    expect(dualWriteSpy).toHaveBeenCalledTimes(1);
    expect(loggerInfoSpy).toHaveBeenCalledWith(
      "[wahoo] Webhook: inserted 1 sensor sample rows for workout 42",
    );
  });

  it("returns early when activity insert returns no id", async () => {
    const mockInsert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    });
    const mockDb = {
      select: vi.fn(),
      insert: mockInsert,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn(),
    };

    const provider = new WahooProvider(async () => new Response());
    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "42",
      eventType: "create",
      objectType: "workout",
      objectId: "99",
      metadata: {
        payload: {
          user: { id: 42 },
          workout: {
            id: 42,
            workout_type_id: 0,
            starts: "2026-03-01T08:00:00Z",
            created_at: "2026-03-01T10:00:00Z",
            updated_at: "2026-03-01T10:00:00Z",
            workout_summary: {
              id: 101,
              created_at: "2026-03-01T10:00:00Z",
              updated_at: "2026-03-01T10:00:00Z",
              file: { url: "https://cdn.wahoo.com/test.fit" },
            },
          },
        },
      },
    });

    // Activity counted as synced but no FIT file download attempted
    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("collects DB insert errors for the activity upsert", async () => {
    const insertError = new Error("DB constraint violation");
    const mockInsert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockRejectedValue(insertError),
        }),
      }),
    });
    const mockDb = {
      select: vi.fn(),
      insert: mockInsert,
      delete: vi.fn(),
      execute: vi.fn(),
    };

    const provider = new WahooProvider(async () => new Response());
    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "42",
      eventType: "create",
      objectType: "workout",
      objectId: "99",
      metadata: {
        payload: {
          user: { id: 42 },
          workout: {
            id: 42,
            workout_type_id: 0,
            starts: "2026-03-01T08:00:00Z",
            created_at: "2026-03-01T10:00:00Z",
            updated_at: "2026-03-01T10:00:00Z",
          },
        },
      },
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("DB constraint violation");
  });
});

describe("WahooProvider.sync", () => {
  it("writes sensor sample rows from FIT workouts during sync", async () => {
    vi.spyOn(resolveTokensModule, "resolveOAuthTokens").mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: new Date("2026-03-02T00:00:00Z"),
      scopes: null,
    });
    vi.spyOn(fitParserModule, "parseFitFile").mockResolvedValue({
      session: sampleParsedFitSession,
      records: [
        {
          recordedAt: new Date("2026-03-01T08:00:00Z"),
          heartRate: 145,
          power: 210,
          cadence: 88,
          speed: 8.5,
          distance: 100,
          raw: { heart_rate: 145, power: 210 },
        },
      ],
      laps: [],
      events: [],
    });
    const dualWriteSpy = vi
      .spyOn(sensorSampleWriterModule, "dualWriteToSensorSample")
      .mockResolvedValue(0);
    const loggerInfoSpy = vi
      .spyOn(loggerModule.logger, "info")
      .mockImplementation(() => loggerModule.logger);
    const mockDb = {
      select: vi.fn(),
      insert: makeWahooInsertMock("activity-sync-1"),
      delete: vi.fn(),
      execute: vi.fn(),
    };
    const provider = new WahooProvider(async (input): Promise<Response> => {
      const url = String(input);
      if (url.includes("/v1/workouts")) {
        return Response.json({
          workouts: [
            {
              id: 42,
              workout_type_id: 0,
              starts: "2026-03-01T08:00:00Z",
              created_at: "2026-03-01T10:00:00Z",
              updated_at: "2026-03-01T10:00:00Z",
              workout_summary: {
                id: 101,
                created_at: "2026-03-01T10:00:00Z",
                updated_at: "2026-03-01T10:00:00Z",
                file: { url: "https://cdn.wahoo.com/sync.fit" },
              },
            },
          ],
          total: 1,
          page: 1,
          per_page: 30,
          order: "desc",
          sort: "starts",
        });
      }
      if (url === "https://cdn.wahoo.com/sync.fit") {
        return new Response(new Uint8Array([1, 2, 3]));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const result = await provider.sync(mockDb, new Date("2026-02-01T00:00:00Z"));

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(dualWriteSpy).toHaveBeenCalledTimes(1);
    expect(loggerInfoSpy).toHaveBeenCalledWith(
      "[wahoo] Inserted 1 sensor sample rows for workout 42",
    );
  });
});

// ============================================================
// Additional precise assertions for mutation killing
// ============================================================

describe("WahooProvider — precise webhook assertions", () => {
  it("parseWebhookPayload exact event for workout_summary.updated vs other types", () => {
    const provider = new WahooProvider(async () => new Response());

    // workout_summary.updated should return "update"
    const updatedEvents = provider.parseWebhookPayload({
      event_type: "workout_summary.updated",
      user: { id: 7 },
      workout_summary: {
        id: 33,
        created_at: "2026-03-01T10:00:00Z",
        updated_at: "2026-03-01T10:00:00Z",
      },
    });
    expect(updatedEvents[0]?.eventType).toBe("update");
    expect(updatedEvents[0]?.ownerExternalId).toBe("7");
    expect(updatedEvents[0]?.objectType).toBe("workout");
    expect(updatedEvents[0]?.objectId).toBe("33");

    // Any other event_type should return "create"
    const createdEvents = provider.parseWebhookPayload({
      event_type: "workout_summary.created",
      user: { id: 8 },
    });
    expect(createdEvents[0]?.eventType).toBe("create");

    // event_type undefined should return "create"
    const noTypeEvents = provider.parseWebhookPayload({
      user: { id: 9 },
    });
    expect(noTypeEvents[0]?.eventType).toBe("create");
  });

  it("parseWebhookPayload with workout_summary id=0 returns objectId '0'", () => {
    const provider = new WahooProvider(async () => new Response());

    // Edge case: id=0 is falsy but should still produce "0"
    const events = provider.parseWebhookPayload({
      user: { id: 1 },
      workout_summary: {
        id: 0,
        created_at: "2026-03-01T10:00:00Z",
        updated_at: "2026-03-01T10:00:00Z",
      },
    });
    // id=0 is falsy in JS, so the `?.id ? String(...) : undefined` check matters
    expect(events).toHaveLength(1);
    // Zero is falsy, so objectId should be undefined (due to the ternary)
    expect(events[0]?.objectId).toBeUndefined();
  });

  it("parseWebhookPayload includes full payload in metadata", () => {
    const provider = new WahooProvider(async () => new Response());
    const inputPayload = {
      event_type: "workout_summary.created",
      user: { id: 42 },
      webhook_token: "wh-tok",
    };

    const events = provider.parseWebhookPayload(inputPayload);
    expect(events[0]?.metadata).toEqual({ payload: inputPayload });
  });

  it("registerWebhook returns exact string 'wahoo-portal-subscription'", async () => {
    const provider = new WahooProvider(async () => new Response());
    const result = await provider.registerWebhook("https://example.com/cb", "tok");
    expect(result.subscriptionId).toBe("wahoo-portal-subscription");
    expect(result.signingSecret).toBeUndefined();
    expect(result.expiresAt).toBeUndefined();
  });

  it("verifyWebhookSignature returns exactly true for any input", () => {
    const provider = new WahooProvider(async () => new Response());
    expect(provider.verifyWebhookSignature(Buffer.from(""), {}, "")).toBe(true);
    expect(provider.verifyWebhookSignature(Buffer.from("body"), { "x-sig": "abc" }, "secret")).toBe(
      true,
    );
  });

  it("syncWebhookEvent returns provider as 'wahoo' for all paths", async () => {
    const provider = new WahooProvider(async () => new Response());
    const mockDb = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
    };

    // Non-workout path
    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "1",
      eventType: "create",
      objectType: "user",
    });
    expect(result.provider).toBe("wahoo");
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.errors).toEqual([]);
    expect(result.recordsSynced).toBe(0);
  });

  it("syncWebhookEvent invalid payload path returns provider 'wahoo'", async () => {
    const provider = new WahooProvider(async () => new Response());
    const mockDb = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
    };

    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "1",
      eventType: "create",
      objectType: "workout",
      metadata: { payload: "not-an-object" },
    });
    expect(result.provider).toBe("wahoo");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("syncWebhookEvent summary-only path returns provider 'wahoo'", async () => {
    const provider = new WahooProvider(async () => new Response());
    const mockDb = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
    };

    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "1",
      eventType: "create",
      objectType: "workout",
      metadata: {
        payload: {
          user: { id: 1 },
          workout_summary: {
            id: 1,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
      },
    });
    expect(result.provider).toBe("wahoo");
    expect(result.recordsSynced).toBe(0);
  });

  it("syncWebhookEvent no-workout-data path returns provider 'wahoo'", async () => {
    const provider = new WahooProvider(async () => new Response());
    const mockDb = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
    };

    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "1",
      eventType: "create",
      objectType: "workout",
      metadata: {
        payload: {
          user: { id: 1 },
        },
      },
    });
    expect(result.provider).toBe("wahoo");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe("Webhook payload missing workout data");
  });

  it("parseWorkoutSummary name is undefined when workout has no name", () => {
    const workout: WahooWorkout = {
      id: 10,
      workout_type_id: 0,
      starts: "2026-03-01T10:00:00Z",
      created_at: "2026-03-01T10:00:00Z",
      updated_at: "2026-03-01T10:00:00Z",
    };
    const result = parseWorkoutSummary(workout);
    expect(result.name).toBeUndefined();
    expect(result.externalId).toBe("10");
    expect(result.activityType).toBe("cycling");
    expect(result.startedAt).toEqual(new Date("2026-03-01T10:00:00Z"));
    expect(result.endedAt).toBeUndefined();
    expect(result.fitFileUrl).toBeUndefined();
  });

  it("syncWebhookEvent FIT file error includes externalId and original error message", async () => {
    const mockInsert = makeWahooInsertMock();
    const mockDelete = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    const mockDb = {
      select: vi.fn(),
      insert: mockInsert,
      delete: mockDelete,
      execute: vi.fn(),
    };

    // FIT file URL download throws a custom error
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Server Error", { status: 500 });
    };

    const provider = new WahooProvider(mockFetch);
    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "42",
      eventType: "create",
      objectType: "workout",
      objectId: "99",
      metadata: {
        payload: {
          user: { id: 42 },
          workout: {
            id: 42,
            workout_type_id: 0,
            starts: "2026-03-01T08:00:00Z",
            created_at: "2026-03-01T10:00:00Z",
            updated_at: "2026-03-01T10:00:00Z",
            workout_summary: {
              id: 101,
              created_at: "2026-03-01T10:00:00Z",
              updated_at: "2026-03-01T10:00:00Z",
              file: { url: "https://cdn.wahoo.com/bad.fit" },
            },
          },
        },
      },
    });

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(1);
    // Assert exact error format: "FIT file for <externalId>: <message>"
    expect(result.errors[0]?.message).toMatch(/^FIT file for 42: /);
    expect(result.errors[0]?.externalId).toBe("42");
    expect(result.errors[0]?.cause).toBeDefined();
  });

  it("syncWebhookEvent outer catch includes externalId from parsed workout", async () => {
    // Simulate the outer catch by having the activity insert itself throw
    const mockInsert = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockRejectedValue(new Error("outer fail")),
        }),
      }),
    });
    const mockDb = {
      select: vi.fn(),
      insert: mockInsert,
      delete: vi.fn(),
      execute: vi.fn(),
    };

    const provider = new WahooProvider(async () => new Response());
    const result = await provider.syncWebhookEvent(mockDb, {
      ownerExternalId: "42",
      eventType: "create",
      objectType: "workout",
      objectId: "99",
      metadata: {
        payload: {
          user: { id: 42 },
          workout: {
            id: 77,
            workout_type_id: 1,
            starts: "2026-03-01T08:00:00Z",
            created_at: "2026-03-01T10:00:00Z",
            updated_at: "2026-03-01T10:00:00Z",
          },
        },
      },
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("outer fail");
    expect(result.errors[0]?.externalId).toBe("77");
  });

  it("wahooOAuthConfig includes exact API URLs using WAHOO_API_BASE", () => {
    const originalEnv = { ...process.env };
    process.env.WAHOO_CLIENT_ID = "id";
    process.env.WAHOO_CLIENT_SECRET = "secret";
    const config = wahooOAuthConfig();
    expect(config?.authorizeUrl).toBe("https://api.wahooligan.com/oauth/authorize");
    expect(config?.tokenUrl).toBe("https://api.wahooligan.com/oauth/token");
    expect(config?.scopes).toEqual(["email", "user_read", "workouts_read", "offline_data"]);
    process.env = { ...originalEnv };
  });

  it("WahooProvider.authSetup apiBaseUrl matches exact Wahoo API base", () => {
    const originalEnv = { ...process.env };
    process.env.WAHOO_CLIENT_ID = "id";
    process.env.WAHOO_CLIENT_SECRET = "secret";
    const provider = new WahooProvider();
    const setup = provider.authSetup();
    expect(setup.apiBaseUrl).toBe("https://api.wahooligan.com");
    process.env = { ...originalEnv };
  });
});
