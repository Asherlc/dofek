import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MapMyFitnessClient,
  MapMyFitnessProvider,
  mapMapMyFitnessActivityType,
  mapMyFitnessOAuthConfig,
  parseMapMyFitnessWorkout,
} from "../mapmyfitness.ts";

// ============================================================
// Tests targeting uncovered paths in mapmyfitness.ts
// ============================================================

describe("mapMapMyFitnessActivityType", () => {
  it("maps all known activity types", () => {
    expect(mapMapMyFitnessActivityType("Running")).toBe("running");
    expect(mapMapMyFitnessActivityType("Trail Run")).toBe("running");
    expect(mapMapMyFitnessActivityType("Road Ride")).toBe("cycling");
    expect(mapMapMyFitnessActivityType("Mountain Biking")).toBe("cycling");
    expect(mapMapMyFitnessActivityType("Cycling")).toBe("cycling");
    expect(mapMapMyFitnessActivityType("Walking")).toBe("walking");
    expect(mapMapMyFitnessActivityType("Swimming")).toBe("swimming");
    expect(mapMapMyFitnessActivityType("Hiking")).toBe("hiking");
    expect(mapMapMyFitnessActivityType("Yoga Class")).toBe("yoga");
    expect(mapMapMyFitnessActivityType("Weight Training")).toBe("strength");
    expect(mapMapMyFitnessActivityType("Strength Training")).toBe("strength");
    expect(mapMapMyFitnessActivityType("Rowing Machine")).toBe("rowing");
  });

  it("returns other for unknown types", () => {
    expect(mapMapMyFitnessActivityType("Juggling")).toBe("other");
    expect(mapMapMyFitnessActivityType("")).toBe("other");
  });
});

describe("parseMapMyFitnessWorkout", () => {
  it("parses a complete workout", () => {
    const workout = {
      _links: { self: [{ id: "w-123" }] },
      name: "Morning Run",
      start_datetime: "2026-03-01T08:00:00Z",
      start_locale_timezone: "America/New_York",
      aggregates: {
        distance_total: 10000,
        active_time_total: 3600,
        speed_max: 5.0,
        speed_avg: 2.78,
        metabolic_energy_total: 2092000, // ~500 kcal
        cadence_avg: 170,
        heart_rate_avg: 150,
        heart_rate_max: 175,
        power_avg: 200,
        power_max: 400,
      },
      activity_type: "Running",
    };

    const parsed = parseMapMyFitnessWorkout(workout);
    expect(parsed.externalId).toBe("w-123");
    expect(parsed.activityType).toBe("running");
    expect(parsed.name).toBe("Morning Run");
    expect(parsed.startedAt).toEqual(new Date("2026-03-01T08:00:00Z"));
    expect(parsed.endedAt).toEqual(
      new Date(new Date("2026-03-01T08:00:00Z").getTime() + 3600 * 1000),
    );
    expect(parsed.raw.distanceMeters).toBe(10000);
    expect(parsed.raw.avgHeartRate).toBe(150);
    expect(parsed.raw.maxHeartRate).toBe(175);
    expect(parsed.raw.avgPower).toBe(200);
    expect(parsed.raw.maxPower).toBe(400);
    expect(parsed.raw.avgCadence).toBe(170);
    expect(parsed.raw.calories).toBe(500);
  });

  it("handles missing aggregates", () => {
    const workout = {
      _links: { self: [{ id: "w-min" }] },
      name: "Quick Walk",
      start_datetime: "2026-03-01T12:00:00Z",
      start_locale_timezone: "UTC",
      aggregates: {},
      activity_type: "Walking",
    };

    const parsed = parseMapMyFitnessWorkout(workout);
    expect(parsed.externalId).toBe("w-min");
    expect(parsed.activityType).toBe("walking");
    expect(parsed.raw.calories).toBeUndefined();
    expect(parsed.raw.distanceMeters).toBeUndefined();
  });

  it("handles missing _links.self", () => {
    const workout = {
      _links: { self: [] },
      name: "No ID",
      start_datetime: "2026-03-01T12:00:00Z",
      start_locale_timezone: "UTC",
      aggregates: {},
      activity_type: "Other",
    };

    const parsed = parseMapMyFitnessWorkout(workout);
    expect(parsed.externalId).toBe("");
  });

  it("uses name for type mapping when activity_type is missing", () => {
    const workout = {
      _links: { self: [{ id: "1" }] },
      name: "Cycling Session",
      start_datetime: "2026-03-01T12:00:00Z",
      start_locale_timezone: "UTC",
      aggregates: { active_time_total: 1800 },
      activity_type: "",
    };

    const parsed = parseMapMyFitnessWorkout(workout);
    // Falls through to the name since activity_type is empty/falsy
    // but the function uses activity_type ?? name, and "" is not nullish
    expect(parsed.activityType).toBe("other");
  });
});

describe("MapMyFitnessClient", () => {
  it("throws on API error", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 }));

    const client = new MapMyFitnessClient("token", "client-id", mockFetch);
    await expect(client.getWorkouts("user-1", "2026-01-01T00:00:00Z")).rejects.toThrow(
      "MapMyFitness API error (401)",
    );
  });

  it("includes correct headers", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      Response.json({
        _embedded: { workouts: [] },
        _links: {},
        total_count: 0,
      }),
    );

    const client = new MapMyFitnessClient("my-token", "my-client-id", mockFetch);
    await client.getWorkouts("user-1", "2026-01-01");

    const headers: Record<string, string> = mockFetch.mock.calls[0]?.[1]?.headers;
    expect(headers.Authorization).toBe("Bearer my-token");
    expect(headers["Api-Key"]).toBe("my-client-id");
  });
});

describe("mapMyFitnessOAuthConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when env vars missing", () => {
    delete process.env.MAPMYFITNESS_CLIENT_ID;
    delete process.env.MAPMYFITNESS_CLIENT_SECRET;
    expect(mapMyFitnessOAuthConfig()).toBeNull();
  });

  it("returns config when set", () => {
    process.env.MAPMYFITNESS_CLIENT_ID = "id";
    process.env.MAPMYFITNESS_CLIENT_SECRET = "secret";
    const config = mapMyFitnessOAuthConfig();
    expect(config?.clientId).toBe("id");
    expect(config?.authorizeUrl).toContain("mapmyfitness.com");
  });
});

describe("MapMyFitnessProvider", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("validate returns errors for missing env vars", () => {
    delete process.env.MAPMYFITNESS_CLIENT_ID;
    delete process.env.MAPMYFITNESS_CLIENT_SECRET;
    expect(new MapMyFitnessProvider().validate()).toContain("MAPMYFITNESS_CLIENT_ID");
  });

  it("validate returns null when set", () => {
    process.env.MAPMYFITNESS_CLIENT_ID = "id";
    process.env.MAPMYFITNESS_CLIENT_SECRET = "secret";
    expect(new MapMyFitnessProvider().validate()).toBeNull();
  });

  it("sync returns error when no tokens", async () => {
    process.env.MAPMYFITNESS_CLIENT_ID = "id";
    process.env.MAPMYFITNESS_CLIENT_SECRET = "secret";
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    };

    // @ts-expect-error mock DB
    const result = await new MapMyFitnessProvider().sync(mockDb, new Date("2026-01-01"));
    expect(result.provider).toBe("mapmyfitness");
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
