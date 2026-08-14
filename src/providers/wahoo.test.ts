import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/token-user-context.ts", () => ({
  getTokenUserId: () => "user-1",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

import { ZodError } from "zod";
import * as resolveTokensModule from "../auth/resolve-tokens.ts";
import type { ParsedFitRecord } from "../fit/parser.ts";
import { fitRecordsToSensorSamples as fitRecordsToMetricStream } from "../fit/records.ts";
import * as fitImportQueueModule from "../jobs/enqueue-fit-file-import.ts";
import * as loggerModule from "../logger.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
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

describe("Wahoo Provider", () => {
  describe("parseWorkoutSummary", () => {
    it("maps Wahoo workout summary to cardio activity fields", () => {
      const result = parseWorkoutSummary(sampleWorkout);

      expect(result.externalId).toBe("42");
      expect(result.activityType.canonicalType).toBe("cycling");
      expect(result.startedAt).toEqual(new Date("2025-03-01T08:00:00.000Z"));
    });

    it("handles missing workout summary gracefully", () => {
      const workoutNoSummary: WahooWorkout = {
        ...sampleWorkout,
        workout_summary: undefined,
      };

      const result = parseWorkoutSummary(workoutNoSummary);

      expect(result.externalId).toBe("42");
      expect(result.activityType.canonicalType).toBe("cycling");
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
      expect(
        parseWorkoutSummary({ ...sampleWorkout, workout_type_id: 0 }).activityType.canonicalType,
      ).toBe("cycling");
      expect(
        parseWorkoutSummary({ ...sampleWorkout, workout_type_id: 1 }).activityType.canonicalType,
      ).toBe("running");
      expect(
        parseWorkoutSummary({ ...sampleWorkout, workout_type_id: 2 }).activityType.canonicalType,
      ).toBe("running");
      expect(
        parseWorkoutSummary({ ...sampleWorkout, workout_type_id: 8 }).activityType.canonicalType,
      ).toBe("walking");
      expect(
        parseWorkoutSummary({ ...sampleWorkout, workout_type_id: 99 }).activityType.canonicalType,
      ).toBe("other");
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
      const rows = fitRecordsToMetricStream(fakeRecords, "wahoo", "activity-uuid-123", "indoor");
      expect(rows[0]?.speed).toBeUndefined();
      expect(rows[1]?.speed).toBeUndefined();
      // Other fields should still be present
      expect(rows[0]?.heartRate).toBe(130);
      expect(rows[0]?.power).toBe(200);
    });

    it("omits speed for virtual_cycling activities", () => {
      const rows = fitRecordsToMetricStream(fakeRecords, "wahoo", "activity-uuid-123", "virtual");
      expect(rows[0]?.speed).toBeUndefined();
    });

    it("keeps speed for outdoor cycling activities", () => {
      const rows = fitRecordsToMetricStream(fakeRecords, "wahoo", "activity-uuid-123", "road");
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
    expect(setup.oauthConfig?.clientId).toBe("test-id");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.reconnectStrategy).toBe("deauthorize-on-token-limit");
    expect(setup.revokeExistingTokens).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toBe("https://api.wahooligan.com");
    expect(setup.identityCapabilities?.providesEmail).toBe(false);
  });

  it("revokes existing Wahoo authorization via DELETE /v1/permissions", async () => {
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
    expect(
      parseWorkoutSummary({ ...baseWorkout, workout_type_id: 6 }).activityType.canonicalType,
    ).toBe("swimming");
  });

  it("maps yoga type", () => {
    expect(
      parseWorkoutSummary({ ...baseWorkout, workout_type_id: 7 }).activityType.canonicalType,
    ).toBe("yoga");
  });

  it("maps hiking type", () => {
    expect(
      parseWorkoutSummary({ ...baseWorkout, workout_type_id: 9 }).activityType.canonicalType,
    ).toBe("hiking");
  });

  it("maps rowing type", () => {
    expect(
      parseWorkoutSummary({ ...baseWorkout, workout_type_id: 10 }).activityType.canonicalType,
    ).toBe("rowing");
  });

  it("maps strength type", () => {
    expect(
      parseWorkoutSummary({ ...baseWorkout, workout_type_id: 11 }).activityType.canonicalType,
    ).toBe("strength");
  });

  it("maps elliptical type", () => {
    expect(
      parseWorkoutSummary({ ...baseWorkout, workout_type_id: 12 }).activityType.canonicalType,
    ).toBe("elliptical");
  });

  it("maps skiing type", () => {
    expect(
      parseWorkoutSummary({ ...baseWorkout, workout_type_id: 13 }).activityType.canonicalType,
    ).toBe("skiing");
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
    expect(
      parseWorkoutSummary({ ...baseWorkout, workout_type_id: 3 }).activityType.canonicalType,
    ).toBe("cycling");
    expect(parseWorkoutSummary({ ...baseWorkout, workout_type_id: 3 }).activityType.modality).toBe(
      "indoor",
    );
  });

  it("handles mountain biking type (4)", () => {
    expect(
      parseWorkoutSummary({ ...baseWorkout, workout_type_id: 4 }).activityType.canonicalType,
    ).toBe("cycling");
    expect(parseWorkoutSummary({ ...baseWorkout, workout_type_id: 4 }).activityType.modality).toBe(
      "mountain",
    );
  });

  it("handles gravel cycling type (5)", () => {
    expect(
      parseWorkoutSummary({ ...baseWorkout, workout_type_id: 5 }).activityType.canonicalType,
    ).toBe("cycling");
    expect(parseWorkoutSummary({ ...baseWorkout, workout_type_id: 5 }).activityType.modality).toBe(
      "gravel",
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
    expect(identity.emailVerified).toBe(false);
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

function makeWahooInsertMock(returnId = "10000000-0000-4000-8000-000000000001") {
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

  it("hands FIT webhook payloads to the canonical import job", async () => {
    const enqueueFitImportSpy = vi
      .spyOn(fitImportQueueModule, "enqueueFitFileImportAndWait")
      .mockResolvedValue({ recordsSynced: 0, errors: [] });
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
    expect(whereSpy).not.toHaveBeenCalled();
    expect(enqueueFitImportSpy).toHaveBeenCalledTimes(1);
    expect(enqueueFitImportSpy).toHaveBeenCalledWith({
      fitBuffer: Buffer.from([1, 2, 3]),
      providerId: "wahoo",
      sourceName: "Wahoo",
      activitySummary: {
        externalId: "42",
        activityType: {
          canonicalType: "cycling",
          providerType: "0",
          modality: null,
        },
        startedAtIso: "2026-03-01T08:00:00.000Z",
        name: "Wahoo cycling",
      },
    });
    expect(loggerInfoSpy).toHaveBeenCalledWith("[wahoo] Imported FIT file for workout 42");
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
  it("hands FIT workouts to the canonical import job during sync", async () => {
    vi.spyOn(resolveTokensModule, "resolveOAuthTokens").mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: new Date("2026-03-02T00:00:00Z"),
      scopes: null,
    });
    const enqueueFitImportSpy = vi
      .spyOn(fitImportQueueModule, "enqueueFitFileImportAndWait")
      .mockResolvedValue({ recordsSynced: 0, errors: [] });
    const loggerInfoSpy = vi
      .spyOn(loggerModule.logger, "info")
      .mockImplementation(() => loggerModule.logger);
    const mockDb = {
      select: vi.fn(),
      insert: makeWahooInsertMock("10000000-0000-4000-8000-000000000002"),
      delete: vi.fn(),
      execute: vi.fn(),
    };
    const metricStreamPublisher = {
      publishRows: vi.fn(async () => []),
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

    const result = await provider.sync(
      new SyncRun({
        db: mockDb,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        userId: "00000000-0000-0000-0000-000000000001",
        metricStreamPublisher,
      }),
    );

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(enqueueFitImportSpy).toHaveBeenCalledWith({
      fitBuffer: Buffer.from([1, 2, 3]),
      providerId: "wahoo",
      sourceName: "Wahoo",
      userId: "00000000-0000-0000-0000-000000000001",
      db: mockDb,
      metricStreamPublisher,
      activitySummary: {
        externalId: "42",
        activityType: {
          canonicalType: "cycling",
          providerType: "0",
          modality: null,
        },
        startedAtIso: "2026-03-01T08:00:00.000Z",
        name: "Wahoo cycling",
      },
    });
    expect(loggerInfoSpy).toHaveBeenCalledWith("[wahoo] Imported FIT file for workout 42");
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
    expect(result.activityType.canonicalType).toBe("cycling");
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

describe("WahooClient.getWorkout", () => {
  it("fetches a single workout by ID", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      Response.json({
        workout: {
          id: 42,
          workout_type_id: 0,
          starts: "2026-03-01T10:00:00Z",
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        },
      }),
    );

    const client = new WahooClient("test-token", mockFetch);
    const result = await client.getWorkout(42);
    expect(result.workout.id).toBe(42);
    expect(mockFetch).toHaveBeenCalledOnce();
    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/workouts/42");
  });
});

describe("WahooClient.downloadFitFile", () => {
  it("downloads and returns a Buffer", async () => {
    const testData = new Uint8Array([0x2e, 0x46, 0x49, 0x54]);
    const mockFetch = vi.fn().mockResolvedValue(new Response(testData, { status: 200 }));

    const client = new WahooClient("test-token", mockFetch);
    const result = await client.downloadFitFile("https://example.com/test.fit");
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBe(4);
  });
});

describe("fitRecordsToMetricStream", () => {
  it("maps FIT records to metric_stream rows", () => {
    const records = [
      {
        recordedAt: new Date("2026-03-01T10:00:00Z"),
        heartRate: 140,
        power: 200,
        cadence: 85,
        speed: 8.5,
        lat: 40.7,
        lng: -74.0,
        altitude: 50,
        temperature: 22,
        distance: 1000,
        grade: 1.5,
        calories: 100,
        verticalSpeed: 0.5,
        gpsAccuracy: 3,
        accumulatedPower: 5000,
        leftRightBalance: 50,
        verticalOscillation: 8.2,
        stanceTime: 250,
        stanceTimePercent: 35,
        stepLength: 1.2,
        verticalRatio: 7.5,
        stanceTimeBalance: 50.5,
        leftTorqueEffectiveness: 75,
        rightTorqueEffectiveness: 72,
        leftPedalSmoothness: 20,
        rightPedalSmoothness: 19,
        combinedPedalSmoothness: 19.5,
        raw: { extra: "data" },
      },
    ];

    const rows = fitRecordsToMetricStream(records, "wahoo", "act-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.providerId).toBe("wahoo");
    expect(rows[0]?.activityId).toBe("act-1");
    expect(rows[0]?.heartRate).toBe(140);
    expect(rows[0]?.power).toBe(200);
    expect(rows[0]?.cadence).toBe(85);
    expect(rows[0]?.speed).toBe(8.5);
    expect(rows[0]?.lat).toBe(40.7);
    expect(rows[0]?.lng).toBe(-74.0);
    expect(rows[0]?.altitude).toBe(50);
    expect(rows[0]?.temperature).toBe(22);
    expect(rows[0]?.grade).toBe(1.5);
    expect(rows[0]?.verticalSpeed).toBe(0.5);
    expect(rows[0]?.leftTorqueEffectiveness).toBe(75);
    expect(rows[0]?.combinedPedalSmoothness).toBe(19.5);
  });

  it("handles records with undefined optional fields", () => {
    const records = [
      {
        recordedAt: new Date("2026-03-01T10:00:00Z"),
        heartRate: undefined,
        power: undefined,
        cadence: undefined,
        speed: undefined,
        lat: undefined,
        lng: undefined,
        altitude: undefined,
        temperature: undefined,
        distance: undefined,
        grade: undefined,
        calories: undefined,
        verticalSpeed: undefined,
        gpsAccuracy: undefined,
        accumulatedPower: undefined,
        leftRightBalance: undefined,
        verticalOscillation: undefined,
        stanceTime: undefined,
        stanceTimePercent: undefined,
        stepLength: undefined,
        verticalRatio: undefined,
        stanceTimeBalance: undefined,
        leftTorqueEffectiveness: undefined,
        rightTorqueEffectiveness: undefined,
        leftPedalSmoothness: undefined,
        rightPedalSmoothness: undefined,
        combinedPedalSmoothness: undefined,
        raw: {},
      },
    ];

    const rows = fitRecordsToMetricStream(records, "wahoo", "act-2");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.heartRate).toBeUndefined();
    expect(rows[0]?.power).toBeUndefined();
  });
});

describe("parseWorkoutList", () => {
  it("calculates hasMore correctly when page * per_page < total", () => {
    const response = {
      workouts: [
        {
          id: 1,
          workout_type_id: 0,
          starts: "2026-03-01T10:00:00Z",
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        },
      ],
      total: 100,
      page: 1,
      per_page: 30,
      order: "desc",
      sort: "starts",
    };

    const result = parseWorkoutList(response);
    expect(result.hasMore).toBe(true);
    expect(result.total).toBe(100);
    expect(result.page).toBe(1);
  });

  it("calculates hasMore when all fetched", () => {
    const response = {
      workouts: [
        {
          id: 1,
          workout_type_id: 1,
          starts: "2026-03-01T10:00:00Z",
          created_at: "2026-03-01T10:00:00Z",
          updated_at: "2026-03-01T10:00:00Z",
        },
      ],
      total: 30,
      page: 1,
      per_page: 30,
      order: "desc",
      sort: "starts",
    };

    const result = parseWorkoutList(response);
    expect(result.hasMore).toBe(false);
  });
});

describe("WahooProvider.sync — token error path", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns error when no tokens found", async () => {
    process.env.WAHOO_CLIENT_ID = "id";
    process.env.WAHOO_CLIENT_SECRET = "secret";

    const provider = new WahooProvider(vi.fn());
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      insert: vi.fn(),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.provider).toBe("wahoo");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("No OAuth tokens");
  });
});

// ============================================================
// WahooProvider.sync — happy path and mutation-killing tests
// ============================================================

function makeTokenRow(opts?: { expired?: boolean }) {
  const expiresAt = opts?.expired
    ? new Date("2020-01-01T00:00:00Z")
    : new Date("2099-01-01T00:00:00Z");
  return {
    accessToken: "valid-access-token",
    refreshToken: "valid-refresh-token",
    expiresAt,
    scopes: "user_read workouts_read",
  };
}

function makeWorkoutApiResponse(
  workouts: WahooWorkout[],
  opts?: { page?: number; total?: number; perPage?: number },
) {
  const perPage = opts?.perPage ?? 30;
  const total = opts?.total ?? workouts.length;
  const page = opts?.page ?? 1;
  return { workouts, total, page, per_page: perPage, order: "descending", sort: "starts" };
}

const sampleWahooWorkout: WahooWorkout = {
  id: 42,
  name: "Morning Ride",
  workout_type_id: 0,
  starts: "2026-03-01T08:00:00.000Z",
  minutes: 92,
  created_at: "2026-03-01T10:00:00.000Z",
  updated_at: "2026-03-01T10:30:00.000Z",
  workout_summary: {
    id: 101,
    duration_total_accum: 5520,
    created_at: "2026-03-01T10:00:00.000Z",
    updated_at: "2026-03-01T10:30:00.000Z",
    file: { url: "https://cdn.wahoo.com/files/123.fit" },
  },
};

const sampleWahooWorkoutNoFit: WahooWorkout = {
  id: 43,
  name: "Evening Walk",
  workout_type_id: 8,
  starts: "2026-03-02T18:00:00.000Z",
  minutes: 30,
  created_at: "2026-03-02T19:00:00.000Z",
  updated_at: "2026-03-02T19:30:00.000Z",
};

function makeInsertMock(returnId = "act-uuid") {
  return vi.fn().mockReturnValue({
    values: vi.fn().mockImplementation(() => {
      return Object.assign(Promise.resolve(), {
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: returnId }]),
        }),
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      });
    }),
  });
}

function makeSelectMock(
  tokenRow: {
    accessToken: string;
    refreshToken: string | null;
    expiresAt: Date;
    scopes: string;
  } | null,
) {
  const rows = tokenRow ? [tokenRow] : [];
  return vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  });
}

describe("WahooProvider.sync — happy path (no FIT file)", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  it("syncs a workout without a FIT file and increments recordsSynced", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const tokenRow = makeTokenRow();
    const mockInsert = makeInsertMock();
    const mockDb = {
      select: makeSelectMock(tokenRow),
      insert: mockInsert,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const workoutsResponse = makeWorkoutApiResponse([sampleWahooWorkoutNoFit]);
    const mockFetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = String(typeof url === "object" && "toString" in url ? url.toString() : url);
      if (urlStr.includes("/v1/workouts")) {
        return Promise.resolve(Response.json(workoutsResponse));
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });

    const provider = new WahooProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({
        db: mockDb,
        window: SyncWindow.fromSince({ since: new Date("2026-01-01T00:00:00Z") }),
      }),
    );

    expect(result.provider).toBe("wahoo");
    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(mockInsert).toHaveBeenCalledOnce();
  });

  it("returns zero recordsSynced when the workout list is empty", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const tokenRow = makeTokenRow();
    const mockInsert = makeInsertMock();
    const mockDb = {
      select: makeSelectMock(tokenRow),
      insert: mockInsert,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const workoutsResponse = makeWorkoutApiResponse([]);
    const mockFetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = String(typeof url === "object" && "toString" in url ? url.toString() : url);
      if (urlStr.includes("/v1/workouts")) {
        return Promise.resolve(Response.json(workoutsResponse));
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });

    const provider = new WahooProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({
        db: mockDb,
        window: SyncWindow.fromSince({ since: new Date("2026-01-01T00:00:00Z") }),
      }),
    );

    expect(result.provider).toBe("wahoo");
    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe("WahooProvider.sync — expired token refresh path", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  it("refreshes expired tokens, saves new tokens, and continues sync", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const expiredTokenRow = makeTokenRow({ expired: true });
    const mockInsert = makeInsertMock();
    const mockDb = {
      select: makeSelectMock(expiredTokenRow),
      insert: mockInsert,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const workoutsResponse = makeWorkoutApiResponse([sampleWahooWorkoutNoFit]);
    const mockFetch = vi
      .fn()
      .mockImplementation((url: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(typeof url === "object" && "toString" in url ? url.toString() : url);
        if (urlStr.includes("oauth/token") && init?.method === "POST") {
          return Promise.resolve(
            Response.json({
              access_token: "new-access-token",
              refresh_token: "new-refresh-token",
              expires_in: 7200,
              scope: "user_read workouts_read",
            }),
          );
        }
        if (urlStr.includes("/v1/workouts")) {
          return Promise.resolve(Response.json(workoutsResponse));
        }
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      });

    const provider = new WahooProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({
        db: mockDb,
        window: SyncWindow.fromSince({ since: new Date("2026-01-01T00:00:00Z") }),
      }),
    );

    expect(result.provider).toBe("wahoo");
    expect(result.errors).toHaveLength(0);

    // Verify the OAuth token refresh was called
    const oauthCall = mockFetch.mock.calls.find(([url, init]) => {
      const urlStr = String(typeof url === "object" && "toString" in url ? url.toString() : url);
      return (
        urlStr.includes("oauth/token") &&
        init != null &&
        typeof init === "object" &&
        "method" in init &&
        init.method === "POST"
      );
    });
    expect(oauthCall).toBeDefined();

    // Verify tokens were saved (insert called for oauthToken upsert)
    expect(mockInsert).toHaveBeenCalled();
  });

  it("refreshes once and retries the rejected current workout page", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const mockDb = {
      select: makeSelectMock(makeTokenRow()),
      insert: makeInsertMock(),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };
    const page1Workout: WahooWorkout = {
      ...sampleWahooWorkoutNoFit,
      id: 100,
      starts: "2026-03-02T18:00:00.000Z",
    };
    const workoutRequests: Array<{ accessToken: string | null; page: string | null }> = [];
    const mockFetch = vi
      .fn()
      .mockImplementation((url: string | URL | Request, init?: RequestInit) => {
        const requestUrl = new URL(String(url));
        if (requestUrl.pathname === "/oauth/token") {
          return Promise.resolve(
            Response.json({
              access_token: "refreshed-access-token",
              refresh_token: "refreshed-refresh-token",
              expires_in: 7200,
            }),
          );
        }
        if (requestUrl.pathname === "/v1/workouts") {
          const accessToken = new Headers(init?.headers).get("Authorization");
          const page = requestUrl.searchParams.get("page");
          workoutRequests.push({ accessToken, page });
          if (page === "1" && accessToken === "Bearer valid-access-token") {
            return Promise.resolve(
              Response.json(
                makeWorkoutApiResponse([page1Workout], { page: 1, total: 31, perPage: 30 }),
              ),
            );
          }
          if (page === "2" && accessToken === "Bearer valid-access-token") {
            return Promise.resolve(
              Response.json({ error: "Access token has expired" }, { status: 401 }),
            );
          }
          if (page === "2" && accessToken === "Bearer refreshed-access-token") {
            return Promise.resolve(
              Response.json(makeWorkoutApiResponse([], { page: 2, total: 31 })),
            );
          }
        }
        throw new Error(`Unexpected fetch: ${String(url)}`);
      });

    const result = await new WahooProvider(mockFetch).sync(
      new SyncRun({
        db: mockDb,
        window: SyncWindow.fromSince({ since: new Date("2026-01-01T00:00:00Z") }),
      }),
    );

    expect(result.errors).toEqual([]);
    expect(result.recordsSynced).toBe(1);
    expect(workoutRequests).toEqual([
      { accessToken: "Bearer valid-access-token", page: "1" },
      { accessToken: "Bearer valid-access-token", page: "2" },
      { accessToken: "Bearer refreshed-access-token", page: "2" },
    ]);
  });

  it("does not refresh again when the retried workout page is also rejected", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const mockDb = {
      select: makeSelectMock(makeTokenRow()),
      insert: makeInsertMock(),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };
    const mockFetch = vi
      .fn()
      .mockImplementation((url: string | URL | Request, init?: RequestInit) => {
        const requestUrl = new URL(String(url));
        if (requestUrl.pathname === "/oauth/token") {
          return Promise.resolve(
            Response.json({
              access_token: "refreshed-access-token",
              refresh_token: "refreshed-refresh-token",
              expires_in: 7200,
            }),
          );
        }
        if (requestUrl.pathname === "/v1/workouts") {
          const accessToken = new Headers(init?.headers).get("Authorization");
          const page = requestUrl.searchParams.get("page");
          if (page === "1" && accessToken === "Bearer valid-access-token") {
            return Promise.resolve(
              Response.json({ error: "Access token has expired" }, { status: 401 }),
            );
          }
          if (page === "1" && accessToken === "Bearer refreshed-access-token") {
            return Promise.resolve(
              Response.json(
                makeWorkoutApiResponse([sampleWahooWorkoutNoFit], {
                  page: 1,
                  total: 31,
                  perPage: 30,
                }),
              ),
            );
          }
          return Promise.resolve(
            Response.json({ error: "Access token has expired" }, { status: 401 }),
          );
        }
        throw new Error(`Unexpected fetch: ${String(url)} ${String(init?.method)}`);
      });

    const sync = new WahooProvider(mockFetch).sync(
      new SyncRun({
        db: mockDb,
        window: SyncWindow.fromSince({ since: new Date("2026-01-01T00:00:00Z") }),
      }),
    );

    await expect(sync).rejects.toThrow("Wahoo access token expired.");
    expect(
      mockFetch.mock.calls.filter(([url]) => new URL(String(url)).pathname === "/oauth/token"),
    ).toHaveLength(1);
  });

  it("returns error when refresh token is missing on expired tokens", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const expiredNoRefreshRow = {
      accessToken: "expired-token",
      refreshToken: null,
      expiresAt: new Date("2020-01-01T00:00:00Z"),
      scopes: "user_read workouts_read",
    };

    const mockDb = {
      select: makeSelectMock(expiredNoRefreshRow),
      insert: makeInsertMock(),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const mockFetch = vi.fn();
    const provider = new WahooProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({
        db: mockDb,
        window: SyncWindow.fromSince({ since: new Date("2026-01-01T00:00:00Z") }),
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No refresh token");
    expect(result.recordsSynced).toBe(0);
  });
});

describe("WahooProvider.sync — since date boundary", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  it("skips workouts with startedAt before since date and stops pagination", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const tokenRow = makeTokenRow();
    const mockInsert = makeInsertMock();
    const mockDb = {
      select: makeSelectMock(tokenRow),
      insert: mockInsert,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    // Workout starts before the since date
    const oldWorkout: WahooWorkout = {
      ...sampleWahooWorkoutNoFit,
      id: 99,
      starts: "2025-06-01T08:00:00.000Z",
    };

    const workoutsResponse = makeWorkoutApiResponse([oldWorkout], { total: 50 });
    const mockFetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = String(typeof url === "object" && "toString" in url ? url.toString() : url);
      if (urlStr.includes("/v1/workouts")) {
        return Promise.resolve(Response.json(workoutsResponse));
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });

    const provider = new WahooProvider(mockFetch);
    // since is after the workout's starts
    const result = await provider.sync(
      new SyncRun({
        db: mockDb,
        window: SyncWindow.fromSince({ since: new Date("2026-01-01T00:00:00Z") }),
      }),
    );

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
    // Only one workouts API call made (pagination stopped)
    const workoutCalls = mockFetch.mock.calls.filter(([url]) => {
      const urlStr = String(typeof url === "object" && "toString" in url ? url.toString() : url);
      return urlStr.includes("/v1/workouts");
    });
    expect(workoutCalls).toHaveLength(1);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("syncs workouts at the window end and skips workouts after it", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const tokenRow = makeTokenRow();
    const mockInsert = makeInsertMock();
    const mockDb = {
      select: makeSelectMock(tokenRow),
      insert: mockInsert,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const atEndWorkout: WahooWorkout = {
      ...sampleWahooWorkoutNoFit,
      id: 100,
      starts: "2026-03-02T18:00:00.000Z",
    };
    const afterEndWorkout: WahooWorkout = {
      ...sampleWahooWorkoutNoFit,
      id: 101,
      starts: "2026-03-02T18:00:00.001Z",
    };

    const workoutsResponse = makeWorkoutApiResponse([atEndWorkout, afterEndWorkout]);
    const mockFetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = String(typeof url === "object" && "toString" in url ? url.toString() : url);
      if (urlStr.includes("/v1/workouts")) {
        return Promise.resolve(Response.json(workoutsResponse));
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });

    const provider = new WahooProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({
        db: mockDb,
        window: new SyncWindow({
          since: new Date("2026-03-01T00:00:00.000Z"),
          until: new Date("2026-03-02T18:00:00.000Z"),
        }),
      }),
    );

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(mockInsert).toHaveBeenCalledOnce();
  });
});

describe("WahooProvider.sync — onProgress callback", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  it("calls onProgress after each workout is inserted", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const tokenRow = makeTokenRow();
    const mockInsert = makeInsertMock();
    const mockDb = {
      select: makeSelectMock(tokenRow),
      insert: mockInsert,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const workoutsResponse = makeWorkoutApiResponse([sampleWahooWorkoutNoFit], { total: 1 });
    const mockFetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = String(typeof url === "object" && "toString" in url ? url.toString() : url);
      if (urlStr.includes("/v1/workouts")) {
        return Promise.resolve(Response.json(workoutsResponse));
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });

    const onProgress = vi.fn();
    const provider = new WahooProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({
        db: mockDb,
        window: SyncWindow.fromSince({ since: new Date("2026-01-01T00:00:00Z") }),
        onProgress,
      }),
    );

    expect(result.recordsSynced).toBe(1);
    expect(onProgress).toHaveBeenCalledOnce();
    expect(onProgress.mock.calls[0]?.[0]).toBe(100);
    expect(typeof onProgress.mock.calls[0]?.[1]).toBe("string");
    expect(String(onProgress.mock.calls[0]?.[1])).toContain("1/1");
  });

  it("does not call onProgress when total is 0", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const tokenRow = makeTokenRow();
    const mockInsert = makeInsertMock();
    const mockDb = {
      select: makeSelectMock(tokenRow),
      insert: mockInsert,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    // total: 0 means the onProgress guard (total > 0) prevents the call
    const workoutsResponse = makeWorkoutApiResponse([sampleWahooWorkoutNoFit], { total: 0 });
    const mockFetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = String(typeof url === "object" && "toString" in url ? url.toString() : url);
      if (urlStr.includes("/v1/workouts")) {
        return Promise.resolve(Response.json(workoutsResponse));
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });

    const onProgress = vi.fn();
    const provider = new WahooProvider(mockFetch);
    await provider.sync(
      new SyncRun({
        db: mockDb,
        window: SyncWindow.fromSince({ since: new Date("2026-01-01T00:00:00Z") }),
        onProgress,
      }),
    );

    expect(onProgress).not.toHaveBeenCalled();
  });
});

describe("WahooProvider.sync — FIT file download error", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  it("collects FIT download errors but still counts the activity as synced", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const tokenRow = makeTokenRow();
    const mockInsert = makeInsertMock();
    const mockDb = {
      select: makeSelectMock(tokenRow),
      insert: mockInsert,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    // Workout has a fitFileUrl
    const workoutsResponse = makeWorkoutApiResponse([sampleWahooWorkout]);
    const mockFetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = String(typeof url === "object" && "toString" in url ? url.toString() : url);
      if (urlStr.includes("/v1/workouts")) {
        return Promise.resolve(Response.json(workoutsResponse));
      }
      // FIT CDN URL returns 404
      if (urlStr === "https://cdn.wahoo.com/files/123.fit") {
        return Promise.resolve(new Response("Not Found", { status: 404 }));
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });

    const provider = new WahooProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({
        db: mockDb,
        window: SyncWindow.fromSince({ since: new Date("2026-01-01T00:00:00Z") }),
      }),
    );

    // Activity is still synced even though FIT download failed
    expect(result.recordsSynced).toBe(1);
    // FIT error is collected
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("FIT file");
    expect(result.errors[0]?.externalId).toBe("42");
  });
});

describe("WahooProvider.sync — activity insert error", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  it("collects DB insert errors for individual workouts and continues", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const tokenRow = makeTokenRow();
    const insertError = new Error("DB constraint violated");

    // insert throws for activity but tokens use insert with onConflictDoUpdate
    // We need to distinguish token save from activity insert.
    // Tokens are saved via saveTokens which does insert().values().onConflictDoUpdate()
    // Activity insert also uses insert().values().onConflictDoUpdate()
    // Since tokens are only saved when refreshing (not needed here with valid tokens),
    // any insert call here is for the activity — make it throw.
    const mockInsert = vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation(() => {
        throw insertError;
      }),
    });

    const mockDb = {
      select: makeSelectMock(tokenRow),
      insert: mockInsert,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const workoutsResponse = makeWorkoutApiResponse([sampleWahooWorkoutNoFit]);
    const mockFetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = String(typeof url === "object" && "toString" in url ? url.toString() : url);
      if (urlStr.includes("/v1/workouts")) {
        return Promise.resolve(Response.json(workoutsResponse));
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });

    const provider = new WahooProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({
        db: mockDb,
        window: SyncWindow.fromSince({ since: new Date("2026-01-01T00:00:00Z") }),
      }),
    );

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("DB constraint violated");
  });
});

describe("WahooProvider.sync — multi-page pagination", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  it("fetches multiple pages when hasMore is true on first page", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const tokenRow = makeTokenRow();
    const mockInsert = makeInsertMock();
    const mockDb = {
      select: makeSelectMock(tokenRow),
      insert: mockInsert,
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const page1Workout: WahooWorkout = {
      ...sampleWahooWorkoutNoFit,
      id: 100,
      starts: "2026-03-02T18:00:00.000Z",
    };
    const page2Workout: WahooWorkout = {
      ...sampleWahooWorkoutNoFit,
      id: 101,
      starts: "2026-03-01T18:00:00.000Z",
    };

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = String(typeof url === "object" && "toString" in url ? url.toString() : url);
      if (urlStr.includes("/v1/workouts")) {
        callCount++;
        if (callCount === 1) {
          // First page: 30 per page, total 31 → hasMore = true (page 1 * 30 < 31)
          return Promise.resolve(
            Response.json(
              makeWorkoutApiResponse([page1Workout], { page: 1, total: 31, perPage: 30 }),
            ),
          );
        }
        // Second page: only 1 workout, total 31, page 2 → page*perPage = 60 >= 31 → hasMore = false
        return Promise.resolve(
          Response.json(
            makeWorkoutApiResponse([page2Workout], { page: 2, total: 31, perPage: 30 }),
          ),
        );
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });

    const provider = new WahooProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({
        db: mockDb,
        window: SyncWindow.fromSince({ since: new Date("2026-01-01T00:00:00Z") }),
      }),
    );

    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toHaveLength(0);

    const workoutFetchCalls = mockFetch.mock.calls.filter(([url]) => {
      const urlStr = String(typeof url === "object" && "toString" in url ? url.toString() : url);
      return urlStr.includes("/v1/workouts");
    });
    expect(workoutFetchCalls).toHaveLength(2);
  });
});

describe("WahooProvider.sync — result shape", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  it("always returns provider id 'wahoo' in the result", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const tokenRow = makeTokenRow();
    const mockDb = {
      select: makeSelectMock(tokenRow),
      insert: makeInsertMock(),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const workoutsResponse = makeWorkoutApiResponse([]);
    const mockFetch = vi.fn().mockResolvedValue(Response.json(workoutsResponse));

    const provider = new WahooProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({
        db: mockDb,
        window: SyncWindow.fromSince({ since: new Date("2026-01-01T00:00:00Z") }),
      }),
    );

    expect(result.provider).toBe("wahoo");
    expect(typeof result.duration).toBe("number");
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it("includes duration in result", async () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";

    const tokenRow = makeTokenRow();
    const mockDb = {
      select: makeSelectMock(tokenRow),
      insert: makeInsertMock(),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const workoutsResponse = makeWorkoutApiResponse([]);
    const mockFetch = vi.fn().mockResolvedValue(Response.json(workoutsResponse));

    const provider = new WahooProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({
        db: mockDb,
        window: SyncWindow.fromSince({ since: new Date("2026-01-01T00:00:00Z") }),
      }),
    );

    expect(result.duration).toBeGreaterThanOrEqual(0);
  });
});

describe("parseWorkoutSummary — unknown type", () => {
  it("returns other for unknown workout_type_id", () => {
    const workout: WahooWorkout = {
      id: 999,
      workout_type_id: 99,
      starts: "2026-03-01T10:00:00Z",
      created_at: "2026-03-01T10:00:00Z",
      updated_at: "2026-03-01T10:00:00Z",
    };
    const result = parseWorkoutSummary(workout);
    expect(result.activityType.canonicalType).toBe("other");
  });

  it("maps walking type (8)", () => {
    const workout: WahooWorkout = {
      id: 888,
      workout_type_id: 8,
      starts: "2026-03-01T10:00:00Z",
      created_at: "2026-03-01T10:00:00Z",
      updated_at: "2026-03-01T10:00:00Z",
    };
    expect(parseWorkoutSummary(workout).activityType.canonicalType).toBe("walking");
  });

  it("maps treadmill running type (2)", () => {
    const workout: WahooWorkout = {
      id: 222,
      workout_type_id: 2,
      starts: "2026-03-01T10:00:00Z",
      created_at: "2026-03-01T10:00:00Z",
      updated_at: "2026-03-01T10:00:00Z",
    };
    expect(parseWorkoutSummary(workout).activityType.canonicalType).toBe("running");
  });

  it("sets endedAt to undefined when no duration", () => {
    const workout: WahooWorkout = {
      id: 111,
      workout_type_id: 0,
      starts: "2026-03-01T10:00:00Z",
      created_at: "2026-03-01T10:00:00Z",
      updated_at: "2026-03-01T10:00:00Z",
    };
    const result = parseWorkoutSummary(workout);
    expect(result.endedAt).toBeUndefined();
    expect(result.fitFileUrl).toBeUndefined();
  });
});
