import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mapPolarSport,
  parsePolarDailyActivity,
  parsePolarDuration,
  parsePolarExercise,
  parsePolarSleep,
} from "./polar/parsers.ts";
import { PolarProvider } from "./polar/provider.ts";
import type {
  PolarDailyActivity,
  PolarExercise,
  PolarNightlyRecharge,
  PolarSleep,
} from "./polar/types.ts";

// ============================================================
// Extended Polar tests covering uncovered sport mappings,
// PolarProvider validate/authSetup, and additional edge cases
// ============================================================

describe("mapPolarSport — extended mappings", () => {
  it("maps pilates", () => {
    expect(mapPolarSport("PILATES")).toBe("pilates");
  });

  it("maps cross_country_skiing", () => {
    expect(mapPolarSport("CROSS_COUNTRY_SKIING")).toBe("cross_country_skiing");
  });

  it("maps rowing", () => {
    expect(mapPolarSport("ROWING")).toBe("rowing");
  });

  it("maps elliptical", () => {
    expect(mapPolarSport("ELLIPTICAL")).toBe("elliptical");
  });

  it("maps mountain_biking", () => {
    expect(mapPolarSport("MOUNTAIN_BIKING")).toBe("mountain_biking");
  });

  it("maps trail_running", () => {
    expect(mapPolarSport("TRAIL_RUNNING")).toBe("trail_running");
  });

  it("maps cross_training", () => {
    expect(mapPolarSport("CROSS_TRAINING")).toBe("cross_training");
  });

  it("maps group_exercise", () => {
    expect(mapPolarSport("GROUP_EXERCISE")).toBe("group_exercise");
  });

  it("maps stretching", () => {
    expect(mapPolarSport("STRETCHING")).toBe("stretching");
  });

  it("maps dance", () => {
    expect(mapPolarSport("DANCE")).toBe("dance");
  });

  it("maps martial_arts", () => {
    expect(mapPolarSport("MARTIAL_ARTS")).toBe("martial_arts");
  });

  it("maps tennis", () => {
    expect(mapPolarSport("TENNIS")).toBe("tennis");
  });

  it("maps basketball", () => {
    expect(mapPolarSport("BASKETBALL")).toBe("basketball");
  });

  it("maps soccer", () => {
    expect(mapPolarSport("SOCCER")).toBe("soccer");
  });

  it("maps golf", () => {
    expect(mapPolarSport("GOLF")).toBe("golf");
  });

  it("maps ice_hockey", () => {
    expect(mapPolarSport("ICE_HOCKEY")).toBe("ice_hockey");
  });

  it("maps skiing", () => {
    expect(mapPolarSport("SKIING")).toBe("skiing");
  });

  it("maps snowboarding", () => {
    expect(mapPolarSport("SNOWBOARDING")).toBe("snowboarding");
  });

  it("maps skating", () => {
    expect(mapPolarSport("SKATING")).toBe("skating");
  });

  it("maps rock_climbing", () => {
    expect(mapPolarSport("ROCK_CLIMBING")).toBe("rock_climbing");
  });

  it("maps surfing", () => {
    expect(mapPolarSport("SURFING")).toBe("surfing");
  });

  it("maps kayaking", () => {
    expect(mapPolarSport("KAYAKING")).toBe("kayaking");
  });

  it("maps functional_training", () => {
    expect(mapPolarSport("FUNCTIONAL_TRAINING")).toBe("functional_fitness");
  });

  it("maps bootcamp", () => {
    expect(mapPolarSport("BOOTCAMP")).toBe("bootcamp");
  });

  it("maps boxing", () => {
    expect(mapPolarSport("BOXING")).toBe("boxing");
  });

  it("maps core", () => {
    expect(mapPolarSport("CORE")).toBe("core");
  });

  it("maps aqua_fitness", () => {
    expect(mapPolarSport("AQUA_FITNESS")).toBe("aqua_fitness");
  });

  it("maps circuit_training", () => {
    expect(mapPolarSport("CIRCUIT_TRAINING")).toBe("circuit_training");
  });

  it("maps triathlon", () => {
    expect(mapPolarSport("TRIATHLON")).toBe("triathlon");
  });

  it("maps indoor_cycling to indoor_cycling", () => {
    expect(mapPolarSport("INDOOR_CYCLING")).toBe("indoor_cycling");
  });

  it("maps indoor_rowing to rowing", () => {
    expect(mapPolarSport("INDOOR_ROWING")).toBe("rowing");
  });

  it("maps indoor_running to running", () => {
    expect(mapPolarSport("INDOOR_RUNNING")).toBe("running");
  });

  it("maps indoor_walking to walking", () => {
    expect(mapPolarSport("INDOOR_WALKING")).toBe("walking");
  });

  it("maps treadmill_running to running", () => {
    expect(mapPolarSport("TREADMILL_RUNNING")).toBe("running");
  });

  it("maps stair_climbing to stairmaster", () => {
    expect(mapPolarSport("STAIR_CLIMBING")).toBe("stairmaster");
  });
});

describe("parsePolarDuration — extended edge cases", () => {
  it("handles fractional hours", () => {
    expect(parsePolarDuration("PT1.5H")).toBe(5400);
  });

  it("handles fractional minutes", () => {
    expect(parsePolarDuration("PT1.5M")).toBe(90);
  });
});

describe("parsePolarSleep — edge cases", () => {
  it("handles zero total in-bed time", () => {
    const sleep: PolarSleep = {
      polar_user: "https://www.polar.com/v3/users/12345",
      date: "2024-06-15",
      sleep_start_time: "2024-06-14T22:30:00Z",
      sleep_end_time: "2024-06-14T22:30:00Z", // same start and end
      device_id: "device-abc",
      continuity: 0,
      continuity_class: 0,
      light_sleep: 0,
      deep_sleep: 0,
      rem_sleep: 0,
      unrecognized_sleep_stage: 0,
      sleep_score: 0,
      total_interruption_duration: 0,
      sleep_charge: 1,
      sleep_goal_minutes: 480,
      sleep_rating: 1,
      hypnogram: {},
    };

    const result = parsePolarSleep(sleep);
    expect(result).not.toHaveProperty("efficiencyPct");
    expect(result.durationMinutes).toBe(0);
  });
});

describe("parsePolarExercise — additional mappings", () => {
  it("handles exercise with duration-only format", () => {
    const exercise: PolarExercise = {
      id: "ex-456",
      upload_time: "2024-06-15T10:00:00Z",
      polar_user: "https://www.polar.com/v3/users/12345",
      device: "Polar Vantage M2",
      start_time: "2024-06-15T06:00:00Z",
      duration: "PT45M",
      calories: 300,
      sport: "YOGA",
      has_route: false,
      detailed_sport_info: "Yoga",
    };

    const result = parsePolarExercise(exercise);
    expect(result.activityType).toBe("yoga");
    expect(result.durationSeconds).toBe(2700);
    expect(result.distanceMeters).toBeUndefined();
    expect(result.avgHeartRate).toBeUndefined();
    expect(result.maxHeartRate).toBeUndefined();
  });
});

describe("parsePolarDailyActivity — with null recharge fields", () => {
  it("includes respiratory rate from recharge", () => {
    const daily: PolarDailyActivity = {
      polar_user: "user",
      date: "2024-06-15",
      created: "2024-06-15T23:59:00Z",
      calories: 2000,
      active_calories: 500,
      duration: "PT12H",
      active_steps: 8000,
    };

    const recharge: PolarNightlyRecharge = {
      polar_user: "user",
      date: "2024-06-15",
      heart_rate_avg: 50,
      beat_to_beat_avg: 1000,
      heart_rate_variability_avg: 70,
      breathing_rate_avg: 16.2,
      nightly_recharge_status: 5,
      ans_charge: 8.5,
      ans_charge_status: 5,
    };

    const result = parsePolarDailyActivity(daily, recharge);
    expect(result.respiratoryRateAvg).toBe(16.2);
    expect(result.restingHr).toBe(50);
    expect(result.hrv).toBe(70);
  });
});

describe("PolarProvider — exchangeCode AccessLink registration", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("registers user with AccessLink on exchangeCode", async () => {
    process.env.POLAR_CLIENT_ID = "test-id";
    process.env.POLAR_CLIENT_SECRET = "test-secret";

    const fetchCalls: { url: string; method: string }[] = [];
    const mockFetch: typeof globalThis.fetch = vi.fn(async (url, init) => {
      const urlStr = String(url);
      const method = init?.method ?? "GET";
      fetchCalls.push({ url: urlStr, method });

      // Token exchange
      if (urlStr.includes("oauth2/token")) {
        return new Response(
          JSON.stringify({
            access_token: "new-token",
            refresh_token: "new-refresh",
            expires_in: 31536000,
            x_user_id: "polar-user-123",
            scope: "accesslink.read_all",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // Register (POST /v3/users)
      if (urlStr.includes("/v3/users") && method === "POST") {
        return new Response(null, { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    });

    const provider = new PolarProvider(mockFetch);
    const setup = provider.authSetup();
    expect(setup.exchangeCode).toBeDefined();
    const tokens = await setup.exchangeCode("auth-code");

    expect(tokens.accessToken).toBe("new-token");

    // Verify register was called
    const registerCall = fetchCalls.find(
      (call) => call.method === "POST" && call.url.includes("/v3/users"),
    );
    expect(registerCall).toBeDefined();

    // Verify no deregister was called (deregistration belongs in revokeExistingTokens)
    const deregisterCall = fetchCalls.find(
      (call) => call.method === "DELETE" && call.url.includes("/v3/users/"),
    );
    expect(deregisterCall).toBeUndefined();
  });

  it("throws when AccessLink registration fails with non-409 error", async () => {
    process.env.POLAR_CLIENT_ID = "test-id";
    process.env.POLAR_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = vi.fn(async (url, init) => {
      const urlStr = String(url);

      if (urlStr.includes("oauth2/token")) {
        return new Response(
          JSON.stringify({
            access_token: "new-token",
            x_user_id: "polar-user-123",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // Register fails with 500
      if (init?.method === "POST" && urlStr.includes("/v3/users")) {
        return new Response("Internal Server Error", { status: 500 });
      }

      return new Response("Not found", { status: 404 });
    });

    const provider = new PolarProvider(mockFetch);
    const setup = provider.authSetup();
    expect(setup.exchangeCode).toBeDefined();
    await expect(setup.exchangeCode("auth-code")).rejects.toThrow("registration failed");
  });

  it("succeeds when registration returns 409 (already registered)", async () => {
    process.env.POLAR_CLIENT_ID = "test-id";
    process.env.POLAR_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = vi.fn(async (url, init) => {
      const urlStr = String(url);

      if (urlStr.includes("oauth2/token")) {
        return new Response(
          JSON.stringify({
            access_token: "new-token",
            x_user_id: "polar-user-123",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      // 409 = already registered — should succeed
      if (init?.method === "POST" && urlStr.includes("/v3/users")) {
        return new Response(null, { status: 409 });
      }

      return new Response("Not found", { status: 404 });
    });

    const provider = new PolarProvider(mockFetch);
    const setup = provider.authSetup();
    expect(setup.exchangeCode).toBeDefined();
    const tokens = await setup.exchangeCode("auth-code");
    expect(tokens.accessToken).toBe("new-token");
  });
});

describe("PolarProvider — validate and properties", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("has correct id and name", () => {
    const provider = new PolarProvider();
    expect(provider.id).toBe("polar");
    expect(provider.name).toBe("Polar");
  });

  it("returns error when POLAR_CLIENT_ID is missing", () => {
    delete process.env.POLAR_CLIENT_ID;
    delete process.env.POLAR_CLIENT_SECRET;
    const provider = new PolarProvider();
    expect(provider.validate()).toContain("POLAR_CLIENT_ID");
  });

  it("returns error when POLAR_CLIENT_SECRET is missing", () => {
    process.env.POLAR_CLIENT_ID = "test-id";
    delete process.env.POLAR_CLIENT_SECRET;
    const provider = new PolarProvider();
    expect(provider.validate()).toContain("POLAR_CLIENT_SECRET");
  });

  it("returns null when both env vars are set", () => {
    process.env.POLAR_CLIENT_ID = "test-id";
    process.env.POLAR_CLIENT_SECRET = "test-secret";
    const provider = new PolarProvider();
    expect(provider.validate()).toBeNull();
  });

  it("authSetup returns correct config", () => {
    process.env.POLAR_CLIENT_ID = "test-id";
    process.env.POLAR_CLIENT_SECRET = "test-secret";
    const provider = new PolarProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.clientId).toBe("test-id");
    expect(setup.oauthConfig.clientSecret).toBe("test-secret");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toContain("polaraccesslink.com");
  });

  it("authSetup throws when env vars missing", () => {
    delete process.env.POLAR_CLIENT_ID;
    delete process.env.POLAR_CLIENT_SECRET;
    const provider = new PolarProvider();
    expect(() => provider.authSetup()).toThrow("POLAR_CLIENT_ID");
  });
});
