import { afterEach, describe, expect, it } from "vitest";
import type { ParsedFitRecord } from "../fit/parser.ts";
import {
  fitRecordsToMetricStream,
  parseWorkoutList,
  parseWorkoutSummary,
  WahooClient,
  WahooProvider,
  type WahooWorkout,
  type WahooWorkoutSummary,
  wahooOAuthConfig,
} from "./wahoo.ts";

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
      expect(rows[0]?.distance).toBe(100);
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
    expect(config?.scopes).toContain("workouts_read");
  });

  it("uses custom OAUTH_REDIRECT_URI_unencrypted when set", () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI_unencrypted = "https://example.com/callback";
    const config = wahooOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");
  });

  it("uses default redirect URI when OAUTH_REDIRECT_URI_unencrypted is not set", () => {
    process.env.WAHOO_CLIENT_ID = "test-id";
    process.env.WAHOO_CLIENT_SECRET = "test-secret";
    delete process.env.OAUTH_REDIRECT_URI_unencrypted;
    const config = wahooOAuthConfig();
    expect(config?.redirectUri).toContain("dofek");
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
    expect(setup.apiBaseUrl).toContain("wahooligan.com");
  });

  it("throws when env vars are missing", () => {
    delete process.env.WAHOO_CLIENT_ID;
    delete process.env.WAHOO_CLIENT_SECRET;
    const provider = new WahooProvider();
    expect(() => provider.authSetup()).toThrow("WAHOO_CLIENT_ID");
  });
});

describe("WahooClient — error handling", () => {
  it("throws on non-OK response from workouts endpoint", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Unauthorized", { status: 401 });
    };

    const client = new WahooClient("bad-token", mockFetch);
    await expect(client.getWorkouts()).rejects.toThrow("Wahoo API error (401)");
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
      "cycling",
    );
  });

  it("handles mountain biking type (4)", () => {
    expect(parseWorkoutSummary({ ...baseWorkout, workout_type_id: 4 }).activityType).toBe(
      "cycling",
    );
  });

  it("handles gravel cycling type (5)", () => {
    expect(parseWorkoutSummary({ ...baseWorkout, workout_type_id: 5 }).activityType).toBe(
      "cycling",
    );
  });
});

describe("WahooProvider.getUserIdentity()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns identity from user API", async () => {
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
    expect(identity.email).toBe("user@wahoo.com");
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
