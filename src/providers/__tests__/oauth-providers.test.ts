import { afterEach, describe, expect, it } from "vitest";
import {
  MapMyFitnessClient,
  MapMyFitnessProvider,
  mapMapMyFitnessActivityType,
  mapMyFitnessOAuthConfig,
  parseMapMyFitnessWorkout,
} from "../mapmyfitness.ts";
import {
  mapSuuntoActivityType,
  parseSuuntoWorkout,
  SuuntoProvider,
  suuntoOAuthConfig,
} from "../suunto.ts";
import {
  parseWgerWeightEntry,
  parseWgerWorkoutSession,
  WgerProvider,
  wgerOAuthConfig,
} from "../wger.ts";
import { mapXertSport, XertProvider, xertOAuthConfig } from "../xert.ts";

// ============================================================
// Suunto
// ============================================================

describe("suuntoOAuthConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when SUUNTO_CLIENT_ID is not set", () => {
    delete process.env.SUUNTO_CLIENT_ID;
    delete process.env.SUUNTO_CLIENT_SECRET;
    expect(suuntoOAuthConfig()).toBeNull();
  });

  it("returns null when SUUNTO_CLIENT_SECRET is not set", () => {
    process.env.SUUNTO_CLIENT_ID = "test-id";
    delete process.env.SUUNTO_CLIENT_SECRET;
    expect(suuntoOAuthConfig()).toBeNull();
  });

  it("returns config when both env vars are set", () => {
    process.env.SUUNTO_CLIENT_ID = "test-id";
    process.env.SUUNTO_CLIENT_SECRET = "test-secret";
    const config = suuntoOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toContain("workout");
    expect(config?.tokenAuthMethod).toBe("basic");
  });

  it("uses custom OAUTH_REDIRECT_URI when set", () => {
    process.env.SUUNTO_CLIENT_ID = "test-id";
    process.env.SUUNTO_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI = "https://example.com/callback";
    const config = suuntoOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");
  });

  it("uses default redirect URI when OAUTH_REDIRECT_URI is not set", () => {
    process.env.SUUNTO_CLIENT_ID = "test-id";
    process.env.SUUNTO_CLIENT_SECRET = "test-secret";
    delete process.env.OAUTH_REDIRECT_URI;
    const config = suuntoOAuthConfig();
    expect(config?.redirectUri).toContain("localhost");
  });
});

describe("SuuntoProvider.validate()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns error when SUUNTO_CLIENT_ID is missing", () => {
    delete process.env.SUUNTO_CLIENT_ID;
    delete process.env.SUUNTO_CLIENT_SECRET;
    delete process.env.SUUNTO_SUBSCRIPTION_KEY;
    const provider = new SuuntoProvider();
    expect(provider.validate()).toContain("SUUNTO_CLIENT_ID");
  });

  it("returns error when SUUNTO_CLIENT_SECRET is missing", () => {
    process.env.SUUNTO_CLIENT_ID = "test-id";
    delete process.env.SUUNTO_CLIENT_SECRET;
    delete process.env.SUUNTO_SUBSCRIPTION_KEY;
    const provider = new SuuntoProvider();
    expect(provider.validate()).toContain("SUUNTO_CLIENT_SECRET");
  });

  it("returns error when SUUNTO_SUBSCRIPTION_KEY is missing", () => {
    process.env.SUUNTO_CLIENT_ID = "test-id";
    process.env.SUUNTO_CLIENT_SECRET = "test-secret";
    delete process.env.SUUNTO_SUBSCRIPTION_KEY;
    const provider = new SuuntoProvider();
    expect(provider.validate()).toContain("SUUNTO_SUBSCRIPTION_KEY");
  });

  it("returns null when all three are set", () => {
    process.env.SUUNTO_CLIENT_ID = "test-id";
    process.env.SUUNTO_CLIENT_SECRET = "test-secret";
    process.env.SUUNTO_SUBSCRIPTION_KEY = "test-key";
    const provider = new SuuntoProvider();
    expect(provider.validate()).toBeNull();
  });
});

describe("SuuntoProvider.authSetup()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns auth setup with OAuth config", () => {
    process.env.SUUNTO_CLIENT_ID = "test-id";
    process.env.SUUNTO_CLIENT_SECRET = "test-secret";
    const provider = new SuuntoProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.clientId).toBe("test-id");
    expect(setup.oauthConfig.tokenAuthMethod).toBe("basic");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toContain("suunto.com");
  });

  it("throws when env vars are missing", () => {
    delete process.env.SUUNTO_CLIENT_ID;
    delete process.env.SUUNTO_CLIENT_SECRET;
    const provider = new SuuntoProvider();
    expect(() => provider.authSetup()).toThrow("SUUNTO_CLIENT_ID");
  });
});

describe("mapSuuntoActivityType — additional mappings", () => {
  it("maps walking (11)", () => {
    expect(mapSuuntoActivityType(11)).toBe("walking");
  });

  it("maps strength (14)", () => {
    expect(mapSuuntoActivityType(14)).toBe("strength");
  });

  it("maps yoga (23)", () => {
    expect(mapSuuntoActivityType(23)).toBe("yoga");
  });

  it("maps trail_running (67)", () => {
    expect(mapSuuntoActivityType(67)).toBe("trail_running");
  });

  it("maps rowing (69)", () => {
    expect(mapSuuntoActivityType(69)).toBe("rowing");
  });

  it("maps virtual_cycling (82)", () => {
    expect(mapSuuntoActivityType(82)).toBe("virtual_cycling");
  });

  it("maps virtual_running (83)", () => {
    expect(mapSuuntoActivityType(83)).toBe("virtual_running");
  });

  it("maps cross_country_skiing (4)", () => {
    expect(mapSuuntoActivityType(4)).toBe("cross_country_skiing");
  });
});

describe("parseSuuntoWorkout — edge cases", () => {
  it("uses default name when workoutName is missing", () => {
    const workout = {
      workoutKey: "key-1",
      activityId: 3,
      startTime: 1709290800000,
      stopTime: 1709294400000,
      totalTime: 3600,
      totalDistance: 30000,
      totalAscent: 200,
      totalDescent: 190,
      avgSpeed: 8.33,
      maxSpeed: 12.0,
      energyConsumption: 700,
      stepCount: 0,
    };

    const result = parseSuuntoWorkout(workout);
    expect(result.name).toBe("Suunto cycling");
  });

  it("handles missing hrdata", () => {
    const workout = {
      workoutKey: "key-2",
      activityId: 2,
      startTime: 1709290800000,
      stopTime: 1709294400000,
      totalTime: 3600,
      totalDistance: 10000,
      totalAscent: 100,
      totalDescent: 90,
      avgSpeed: 2.78,
      maxSpeed: 4.0,
      energyConsumption: 500,
      stepCount: 8000,
    };

    const result = parseSuuntoWorkout(workout);
    expect(result.raw.avgHeartRate).toBeUndefined();
    expect(result.raw.maxHeartRate).toBeUndefined();
  });
});

// ============================================================
// Wger
// ============================================================

describe("wgerOAuthConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when WGER_CLIENT_ID is not set", () => {
    delete process.env.WGER_CLIENT_ID;
    delete process.env.WGER_CLIENT_SECRET;
    expect(wgerOAuthConfig()).toBeNull();
  });

  it("returns null when WGER_CLIENT_SECRET is not set", () => {
    process.env.WGER_CLIENT_ID = "test-id";
    delete process.env.WGER_CLIENT_SECRET;
    expect(wgerOAuthConfig()).toBeNull();
  });

  it("returns config when both env vars are set", () => {
    process.env.WGER_CLIENT_ID = "test-id";
    process.env.WGER_CLIENT_SECRET = "test-secret";
    const config = wgerOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toContain("read");
  });

  it("uses custom OAUTH_REDIRECT_URI when set", () => {
    process.env.WGER_CLIENT_ID = "test-id";
    process.env.WGER_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI = "https://example.com/callback";
    const config = wgerOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");
  });
});

describe("WgerProvider.validate()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns error when WGER_CLIENT_ID is missing", () => {
    delete process.env.WGER_CLIENT_ID;
    delete process.env.WGER_CLIENT_SECRET;
    const provider = new WgerProvider();
    expect(provider.validate()).toContain("WGER_CLIENT_ID");
  });

  it("returns error when WGER_CLIENT_SECRET is missing", () => {
    process.env.WGER_CLIENT_ID = "test-id";
    delete process.env.WGER_CLIENT_SECRET;
    const provider = new WgerProvider();
    expect(provider.validate()).toContain("WGER_CLIENT_SECRET");
  });

  it("returns null when both are set", () => {
    process.env.WGER_CLIENT_ID = "test-id";
    process.env.WGER_CLIENT_SECRET = "test-secret";
    const provider = new WgerProvider();
    expect(provider.validate()).toBeNull();
  });
});

describe("WgerProvider.authSetup()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns auth setup with OAuth config", () => {
    process.env.WGER_CLIENT_ID = "test-id";
    process.env.WGER_CLIENT_SECRET = "test-secret";
    const provider = new WgerProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.clientId).toBe("test-id");
    expect(setup.oauthConfig.scopes).toContain("read");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toContain("wger.de");
  });

  it("throws when env vars are missing", () => {
    delete process.env.WGER_CLIENT_ID;
    delete process.env.WGER_CLIENT_SECRET;
    const provider = new WgerProvider();
    expect(() => provider.authSetup()).toThrow("WGER_CLIENT_ID");
  });
});

describe("parseWgerWeightEntry — edge cases", () => {
  it("handles weight with many decimal places", () => {
    const entry = {
      id: 200,
      date: "2026-03-01",
      weight: "82.123456",
    };
    const parsed = parseWgerWeightEntry(entry);
    expect(parsed.weightKg).toBeCloseTo(82.123456);
  });
});

describe("parseWgerWorkoutSession — edge cases", () => {
  it("includes null time_start and time_end in raw", () => {
    const session = {
      id: 600,
      date: "2026-03-01",
      comment: "Leg day",
      impression: "3",
      time_start: null,
      time_end: null,
    };
    const parsed = parseWgerWorkoutSession(session);
    expect(parsed.raw.timeStart).toBeNull();
    expect(parsed.raw.timeEnd).toBeNull();
  });
});

// ============================================================
// Xert
// ============================================================

describe("xertOAuthConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("always returns config (uses public credentials by default)", () => {
    delete process.env.XERT_CLIENT_ID;
    delete process.env.XERT_CLIENT_SECRET;
    const config = xertOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("xert_public");
    expect(config?.clientSecret).toBe("xert_public");
    expect(config?.tokenAuthMethod).toBe("basic");
  });

  it("uses custom XERT_CLIENT_ID when set", () => {
    process.env.XERT_CLIENT_ID = "custom-id";
    process.env.XERT_CLIENT_SECRET = "custom-secret";
    const config = xertOAuthConfig();
    expect(config?.clientId).toBe("custom-id");
    expect(config?.clientSecret).toBe("custom-secret");
  });

  it("uses custom OAUTH_REDIRECT_URI when set", () => {
    process.env.OAUTH_REDIRECT_URI = "https://example.com/callback";
    const config = xertOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");
  });
});

describe("XertProvider.validate()", () => {
  it("returns null (no env vars required)", () => {
    const provider = new XertProvider();
    expect(provider.validate()).toBeNull();
  });
});

describe("XertProvider.authSetup()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns auth setup with public OAuth config", () => {
    delete process.env.XERT_CLIENT_ID;
    delete process.env.XERT_CLIENT_SECRET;
    const provider = new XertProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.clientId).toBe("xert_public");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toContain("xertonline.com");
  });

  it("always works even without env vars", () => {
    delete process.env.XERT_CLIENT_ID;
    delete process.env.XERT_CLIENT_SECRET;
    const provider = new XertProvider();
    expect(() => provider.authSetup()).not.toThrow();
  });
});

describe("mapXertSport — additional mappings", () => {
  it("maps Swimming", () => {
    expect(mapXertSport("Swimming")).toBe("swimming");
  });

  it("maps Walking", () => {
    expect(mapXertSport("Walking")).toBe("walking");
  });

  it("maps Hiking", () => {
    expect(mapXertSport("Hiking")).toBe("hiking");
  });

  it("maps Rowing", () => {
    expect(mapXertSport("Rowing")).toBe("rowing");
  });

  it("maps Skiing", () => {
    expect(mapXertSport("Skiing")).toBe("skiing");
  });

  it("maps Trail Running", () => {
    expect(mapXertSport("Trail Running")).toBe("trail_running");
  });

  it("maps Cross Country Skiing", () => {
    expect(mapXertSport("Cross Country Skiing")).toBe("cross_country_skiing");
  });
});

// ============================================================
// MapMyFitness
// ============================================================

describe("mapMyFitnessOAuthConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when MAPMYFITNESS_CLIENT_ID is not set", () => {
    delete process.env.MAPMYFITNESS_CLIENT_ID;
    delete process.env.MAPMYFITNESS_CLIENT_SECRET;
    expect(mapMyFitnessOAuthConfig()).toBeNull();
  });

  it("returns null when MAPMYFITNESS_CLIENT_SECRET is not set", () => {
    process.env.MAPMYFITNESS_CLIENT_ID = "test-id";
    delete process.env.MAPMYFITNESS_CLIENT_SECRET;
    expect(mapMyFitnessOAuthConfig()).toBeNull();
  });

  it("returns config when both env vars are set", () => {
    process.env.MAPMYFITNESS_CLIENT_ID = "test-id";
    process.env.MAPMYFITNESS_CLIENT_SECRET = "test-secret";
    const config = mapMyFitnessOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toEqual([]);
  });

  it("uses custom OAUTH_REDIRECT_URI when set", () => {
    process.env.MAPMYFITNESS_CLIENT_ID = "test-id";
    process.env.MAPMYFITNESS_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI = "https://example.com/callback";
    const config = mapMyFitnessOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");
  });
});

describe("MapMyFitnessProvider.validate()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns error when MAPMYFITNESS_CLIENT_ID is missing", () => {
    delete process.env.MAPMYFITNESS_CLIENT_ID;
    delete process.env.MAPMYFITNESS_CLIENT_SECRET;
    const provider = new MapMyFitnessProvider();
    expect(provider.validate()).toContain("MAPMYFITNESS_CLIENT_ID");
  });

  it("returns error when MAPMYFITNESS_CLIENT_SECRET is missing", () => {
    process.env.MAPMYFITNESS_CLIENT_ID = "test-id";
    delete process.env.MAPMYFITNESS_CLIENT_SECRET;
    const provider = new MapMyFitnessProvider();
    expect(provider.validate()).toContain("MAPMYFITNESS_CLIENT_SECRET");
  });

  it("returns null when both are set", () => {
    process.env.MAPMYFITNESS_CLIENT_ID = "test-id";
    process.env.MAPMYFITNESS_CLIENT_SECRET = "test-secret";
    const provider = new MapMyFitnessProvider();
    expect(provider.validate()).toBeNull();
  });
});

describe("MapMyFitnessProvider.authSetup()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns auth setup with OAuth config", () => {
    process.env.MAPMYFITNESS_CLIENT_ID = "test-id";
    process.env.MAPMYFITNESS_CLIENT_SECRET = "test-secret";
    const provider = new MapMyFitnessProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.clientId).toBe("test-id");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toContain("mapmyfitness.com");
  });

  it("throws when env vars are missing", () => {
    delete process.env.MAPMYFITNESS_CLIENT_ID;
    delete process.env.MAPMYFITNESS_CLIENT_SECRET;
    const provider = new MapMyFitnessProvider();
    expect(() => provider.authSetup()).toThrow("MAPMYFITNESS_CLIENT_ID");
  });
});

describe("mapMapMyFitnessActivityType — additional mappings", () => {
  it("maps Yoga", () => {
    expect(mapMapMyFitnessActivityType("Yoga")).toBe("yoga");
  });

  it("maps Weight Training", () => {
    expect(mapMapMyFitnessActivityType("Weight Training")).toBe("strength");
  });

  it("maps Strength Training", () => {
    expect(mapMapMyFitnessActivityType("Strength Training")).toBe("strength");
  });

  it("maps Rowing", () => {
    expect(mapMapMyFitnessActivityType("Rowing")).toBe("rowing");
  });

  it("maps Mountain Biking", () => {
    expect(mapMapMyFitnessActivityType("Mountain Biking")).toBe("cycling");
  });

  it("maps Bike Ride", () => {
    expect(mapMapMyFitnessActivityType("Bike Ride")).toBe("cycling");
  });
});

describe("parseMapMyFitnessWorkout — edge cases", () => {
  it("computes endedAt from active_time_total", () => {
    const workout = {
      _links: { self: [{ id: "w-1" }] },
      name: "Evening Walk",
      start_datetime: "2026-03-01T18:00:00+00:00",
      start_locale_timezone: "America/Chicago",
      aggregates: {
        active_time_total: 1800,
      },
      activity_type: "Walk",
    };
    const result = parseMapMyFitnessWorkout(workout);
    expect(result.endedAt).toEqual(
      new Date(new Date("2026-03-01T18:00:00+00:00").getTime() + 1800 * 1000),
    );
  });

  it("handles missing active_time_total (defaults to 0 duration)", () => {
    const workout = {
      _links: { self: [{ id: "w-2" }] },
      name: "Quick Session",
      start_datetime: "2026-03-01T10:00:00+00:00",
      start_locale_timezone: "UTC",
      aggregates: {},
      activity_type: "Run",
    };
    const result = parseMapMyFitnessWorkout(workout);
    expect(result.endedAt).toEqual(result.startedAt);
  });

  it("converts metabolic_energy_total joules to kcal", () => {
    const workout = {
      _links: { self: [{ id: "w-3" }] },
      name: "Swim",
      start_datetime: "2026-03-01T06:00:00+00:00",
      start_locale_timezone: "UTC",
      aggregates: {
        metabolic_energy_total: 2092000, // ~500 kcal
      },
      activity_type: "Swimming",
    };
    const result = parseMapMyFitnessWorkout(workout);
    expect(result.raw.calories).toBe(Math.round(2092000 / 4184));
  });

  it("returns undefined calories when metabolic_energy_total is missing", () => {
    const workout = {
      _links: { self: [{ id: "w-4" }] },
      name: "Yoga Flow",
      start_datetime: "2026-03-01T07:00:00+00:00",
      start_locale_timezone: "UTC",
      aggregates: {},
      activity_type: "Yoga",
    };
    const result = parseMapMyFitnessWorkout(workout);
    expect(result.raw.calories).toBeUndefined();
  });

  it("uses activity_type even when empty string (no fallback to name)", () => {
    const workout = {
      _links: { self: [{ id: "w-5" }] },
      name: "Running Session",
      start_datetime: "2026-03-01T08:00:00+00:00",
      start_locale_timezone: "UTC",
      aggregates: {},
      activity_type: "",
    };
    const result = parseMapMyFitnessWorkout(workout);
    // ?? only falls back on null/undefined, not empty string
    expect(result.activityType).toBe("other");
  });
});

describe("MapMyFitnessClient — error handling", () => {
  it("throws on non-OK response from getWorkouts", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Unauthorized", { status: 401 });
    };

    const client = new MapMyFitnessClient("bad-token", "client-id", mockFetch);
    await expect(client.getWorkouts("-", "2026-03-01T00:00:00Z")).rejects.toThrow(
      "MapMyFitness API error (401)",
    );
  });

  it("throws on 403 Forbidden", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Forbidden", { status: 403 });
    };

    const client = new MapMyFitnessClient("token", "client-id", mockFetch);
    await expect(client.getWorkouts("-", "2026-03-01T00:00:00Z")).rejects.toThrow(
      "MapMyFitness API error (403)",
    );
  });

  it("throws on 500 server error", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Internal Server Error", { status: 500 });
    };

    const client = new MapMyFitnessClient("token", "client-id", mockFetch);
    await expect(client.getWorkouts("-", "2026-03-01T00:00:00Z")).rejects.toThrow(
      "MapMyFitness API error (500): Internal Server Error",
    );
  });

  it("includes error body text in thrown error", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Rate limit exceeded", { status: 429 });
    };

    const client = new MapMyFitnessClient("token", "client-id", mockFetch);
    await expect(client.getWorkouts("-", "2026-03-01T00:00:00Z")).rejects.toThrow(
      "MapMyFitness API error (429): Rate limit exceeded",
    );
  });
});
