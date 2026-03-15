import { afterEach, describe, expect, it } from "vitest";
import {
  parseWorkoutSummary,
  WahooClient,
  WahooProvider,
  type WahooWorkout,
  wahooOAuthConfig,
} from "../wahoo.ts";

// ============================================================
// Coverage tests for uncovered Wahoo paths:
// - wahooOAuthConfig() with/without env vars
// - WahooProvider.validate()
// - WahooProvider.authSetup()
// - WahooClient error handling
// - parseWorkoutSummary edge cases
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
    expect(config?.redirectUri).toContain("localhost");
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
    const mockFetch = (async (): Promise<Response> => {
      return new Response("Unauthorized", { status: 401 });
    }) as typeof globalThis.fetch;

    const client = new WahooClient("bad-token", mockFetch);
    await expect(client.getWorkouts()).rejects.toThrow("Wahoo API error (401)");
  });

  it("throws on FIT file download failure", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return new Response("Not Found", { status: 404 });
    }) as typeof globalThis.fetch;

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

    const mockFetch = (async (): Promise<Response> => {
      return Response.json({
        id: 42,
        email: "user@wahoo.com",
        first_name: "John",
        last_name: "Smith",
      });
    }) as typeof globalThis.fetch;

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

    const mockFetch = (async (): Promise<Response> => {
      return Response.json({ id: 7 });
    }) as typeof globalThis.fetch;

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

    const mockFetch = (async (): Promise<Response> => {
      return new Response("Unauthorized", { status: 401 });
    }) as typeof globalThis.fetch;

    const provider = new WahooProvider(mockFetch);
    const setup = provider.authSetup();
    if (!setup.getUserIdentity) throw new Error("getUserIdentity not defined");
    await expect(setup.getUserIdentity("bad-token")).rejects.toThrow("Wahoo user API error (401)");
  });
});
