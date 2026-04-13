import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/token-user-context.ts", () => ({
  getTokenUserId: () => "user-1",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

import type { SyncDatabase } from "../db/index.ts";
import { PolarClient, PolarNotFoundError, PolarUnauthorizedError } from "./polar/client.ts";
import {
  mapPolarSport,
  parsePolarDailyActivity,
  parsePolarDuration,
  parsePolarExercise,
  parsePolarSleep,
  parsePolarSleepStages,
} from "./polar/parsers.ts";
import { PolarProvider } from "./polar/provider.ts";
import type {
  PolarDailyActivity,
  PolarExercise,
  PolarNightlyRecharge,
  PolarSleep,
} from "./polar/types.ts";

// ============================================================
// Pure parsing unit tests (no DB, no network)
// ============================================================

describe("parsePolarDuration", () => {
  it("parses hours, minutes, and seconds", () => {
    expect(parsePolarDuration("PT1H23M45S")).toBe(5025);
  });

  it("parses hours only", () => {
    expect(parsePolarDuration("PT2H")).toBe(7200);
  });

  it("parses minutes only", () => {
    expect(parsePolarDuration("PT30M")).toBe(1800);
  });

  it("parses seconds only", () => {
    expect(parsePolarDuration("PT45S")).toBe(45);
  });

  it("parses hours and minutes without seconds", () => {
    expect(parsePolarDuration("PT1H30M")).toBe(5400);
  });

  it("parses hours and seconds without minutes", () => {
    expect(parsePolarDuration("PT1H15S")).toBe(3615);
  });

  it("returns 0 for empty duration", () => {
    expect(parsePolarDuration("PT")).toBe(0);
  });

  it("handles fractional seconds", () => {
    expect(parsePolarDuration("PT1M30.5S")).toBe(90.5);
  });
});

describe("mapPolarSport", () => {
  it("maps RUNNING to running", () => {
    expect(mapPolarSport("RUNNING")).toBe("running");
  });

  it("maps CYCLING to cycling", () => {
    expect(mapPolarSport("CYCLING")).toBe("cycling");
  });

  it("maps SWIMMING to swimming", () => {
    expect(mapPolarSport("SWIMMING")).toBe("swimming");
  });

  it("maps WALKING to walking", () => {
    expect(mapPolarSport("WALKING")).toBe("walking");
  });

  it("maps HIKING to hiking", () => {
    expect(mapPolarSport("HIKING")).toBe("hiking");
  });

  it("maps STRENGTH_TRAINING to strength", () => {
    expect(mapPolarSport("STRENGTH_TRAINING")).toBe("strength");
  });

  it("maps YOGA to yoga", () => {
    expect(mapPolarSport("YOGA")).toBe("yoga");
  });

  it("maps unknown sport to other", () => {
    expect(mapPolarSport("SOME_UNKNOWN_SPORT")).toBe("other");
  });

  it("is case-insensitive (lowercases input)", () => {
    expect(mapPolarSport("Running")).toBe("running");
  });
});

const sampleExercise: PolarExercise = {
  id: "abc-123",
  upload_time: "2024-06-15T10:00:00Z",
  polar_user: "https://www.polar.com/v3/users/12345",
  device: "Polar Vantage V3",
  start_time: "2024-06-15T08:00:00Z",
  duration: "PT1H23M45S",
  calories: 650,
  distance: 12500,
  heart_rate: { average: 145, maximum: 178 },
  sport: "RUNNING",
  has_route: true,
  detailed_sport_info: "RUNNING_TRAIL",
};

describe("parsePolarExercise", () => {
  it("maps exercise fields to activity", () => {
    const result = parsePolarExercise(sampleExercise);
    expect(result.externalId).toBe("abc-123");
    expect(result.activityType).toBe("running");
    expect(result.startedAt).toEqual(new Date("2024-06-15T08:00:00Z"));
    expect(result.durationSeconds).toBe(5025);
    expect(result.distanceMeters).toBe(12500);
    expect(result.calories).toBe(650);
    expect(result.avgHeartRate).toBe(145);
    expect(result.maxHeartRate).toBe(178);
    expect(result.name).toBe("RUNNING_TRAIL");
  });

  it("computes endedAt from startedAt + duration", () => {
    const result = parsePolarExercise(sampleExercise);
    const expectedEnd = new Date(new Date("2024-06-15T08:00:00Z").getTime() + 5025 * 1000);
    expect(result.endedAt).toEqual(expectedEnd);
  });

  it("handles exercise without heart rate data", () => {
    const noHr: PolarExercise = {
      ...sampleExercise,
      heart_rate: undefined,
    };
    const result = parsePolarExercise(noHr);
    expect(result.avgHeartRate).toBeUndefined();
    expect(result.maxHeartRate).toBeUndefined();
  });

  it("handles exercise without distance", () => {
    const noDistance: PolarExercise = {
      ...sampleExercise,
      distance: undefined,
    };
    const result = parsePolarExercise(noDistance);
    expect(result.distanceMeters).toBeUndefined();
  });
});

const sampleSleep: PolarSleep = {
  polar_user: "https://www.polar.com/v3/users/12345",
  date: "2024-06-15",
  sleep_start_time: "2024-06-14T22:30:00Z",
  sleep_end_time: "2024-06-15T06:45:00Z",
  device_id: "device-abc",
  continuity: 3.2,
  continuity_class: 3,
  light_sleep: 10800,
  deep_sleep: 7200,
  rem_sleep: 5400,
  unrecognized_sleep_stage: 600,
  sleep_score: 82,
  total_interruption_duration: 1800,
  sleep_charge: 4,
  sleep_goal_minutes: 480,
  sleep_rating: 4,
  hypnogram: {},
};

describe("parsePolarSleep", () => {
  it("maps sleep fields to sleep session", () => {
    const result = parsePolarSleep(sampleSleep);
    expect(result.externalId).toBe("2024-06-15");
    expect(result.startedAt).toEqual(new Date("2024-06-14T22:30:00Z"));
    expect(result.endedAt).toEqual(new Date("2024-06-15T06:45:00Z"));
    expect(result.lightMinutes).toBe(180); // 10800 / 60
    expect(result.deepMinutes).toBe(120); // 7200 / 60
    expect(result.remMinutes).toBe(90); // 5400 / 60
    expect(result.awakeMinutes).toBe(30); // 1800 / 60
  });

  it("computes total duration in minutes from stages", () => {
    const result = parsePolarSleep(sampleSleep);
    // light + deep + rem = 180 + 120 + 90 = 390 minutes
    expect(result.durationMinutes).toBe(390);
  });

  it("does not include efficiencyPct (derived in v_sleep view)", () => {
    const result = parsePolarSleep(sampleSleep);
    expect(result).not.toHaveProperty("efficiencyPct");
  });
});

describe("parsePolarSleepStages", () => {
  const sleepStart = "2024-06-14T22:30:00Z";

  it("converts hypnogram entries to stage intervals", () => {
    const hypnogram: Record<string, number> = {
      "0": 1, // minute 0: deep
      "1": 1, // minute 1: deep
      "2": 2, // minute 2: light
      "3": 2, // minute 3: light
      "4": 3, // minute 4: rem
    };
    const stages = parsePolarSleepStages(sleepStart, hypnogram);
    expect(stages).toHaveLength(3);
    expect(stages[0]?.stage).toBe("deep");
    expect(stages[1]?.stage).toBe("light");
    expect(stages[2]?.stage).toBe("rem");
  });

  it("merges consecutive identical stages into single intervals", () => {
    const hypnogram: Record<string, number> = {
      "0": 1,
      "1": 1,
      "2": 1,
    };
    const stages = parsePolarSleepStages(sleepStart, hypnogram);
    expect(stages).toHaveLength(1);
    expect(stages[0]?.stage).toBe("deep");
    expect(stages[0]?.startedAt).toEqual(new Date("2024-06-14T22:30:00Z"));
    // 3 minutes of deep: starts at minute 0, ends at minute 3
    expect(stages[0]?.endedAt).toEqual(new Date("2024-06-14T22:33:00Z"));
  });

  it("maps hypnogram values 4 and 5 to awake", () => {
    const hypnogram: Record<string, number> = {
      "0": 4,
      "1": 5,
    };
    const stages = parsePolarSleepStages(sleepStart, hypnogram);
    // Both map to "awake" and are consecutive — should merge
    expect(stages).toHaveLength(1);
    expect(stages[0]?.stage).toBe("awake");
  });

  it("computes timestamps relative to sleep start time", () => {
    const hypnogram: Record<string, number> = {
      "60": 1, // 60 minutes after sleep start
      "61": 1,
    };
    const stages = parsePolarSleepStages(sleepStart, hypnogram);
    expect(stages[0]?.startedAt).toEqual(new Date("2024-06-14T23:30:00Z"));
    expect(stages[0]?.endedAt).toEqual(new Date("2024-06-14T23:32:00Z"));
  });

  it("returns empty array for empty hypnogram", () => {
    expect(parsePolarSleepStages(sleepStart, {})).toEqual([]);
  });

  it("skips unknown stage values", () => {
    const hypnogram: Record<string, number> = {
      "0": 99,
      "1": 1,
    };
    const stages = parsePolarSleepStages(sleepStart, hypnogram);
    expect(stages).toHaveLength(1);
    expect(stages[0]?.stage).toBe("deep");
  });

  it("handles non-contiguous minutes as separate intervals", () => {
    const hypnogram: Record<string, number> = {
      "0": 1,
      "1": 1,
      "10": 1, // gap from minute 2 to 10
      "11": 1,
    };
    const stages = parsePolarSleepStages(sleepStart, hypnogram);
    expect(stages).toHaveLength(2);
    expect(stages[0]?.endedAt).toEqual(new Date("2024-06-14T22:32:00Z"));
    expect(stages[1]?.startedAt).toEqual(new Date("2024-06-14T22:40:00Z"));
  });
});

const sampleDailyActivity: PolarDailyActivity = {
  polar_user: "https://www.polar.com/v3/users/12345",
  date: "2024-06-15",
  created: "2024-06-15T23:59:00Z",
  calories: 2500,
  active_calories: 800,
  duration: "PT14H30M",
  active_steps: 12345,
};

const sampleNightlyRecharge: PolarNightlyRecharge = {
  polar_user: "https://www.polar.com/v3/users/12345",
  date: "2024-06-15",
  heart_rate_avg: 52,
  beat_to_beat_avg: 980,
  heart_rate_variability_avg: 65,
  breathing_rate_avg: 14.5,
  nightly_recharge_status: 4,
  ans_charge: 7.5,
  ans_charge_status: 4,
};

describe("parsePolarDailyActivity", () => {
  it("maps daily activity with nightly recharge", () => {
    const result = parsePolarDailyActivity(sampleDailyActivity, sampleNightlyRecharge);
    expect(result.date).toBe("2024-06-15");
    expect(result.steps).toBe(12345);
    expect(result.activeEnergyKcal).toBe(800);
    expect(result.restingHr).toBe(52);
    expect(result.hrv).toBe(65);
    expect(result.respiratoryRateAvg).toBe(14.5);
  });

  it("maps daily activity without nightly recharge", () => {
    const result = parsePolarDailyActivity(sampleDailyActivity, null);
    expect(result.date).toBe("2024-06-15");
    expect(result.steps).toBe(12345);
    expect(result.activeEnergyKcal).toBe(800);
    expect(result.restingHr).toBeUndefined();
    expect(result.hrv).toBeUndefined();
    expect(result.respiratoryRateAvg).toBeUndefined();
  });
});

// ============================================================
// PolarClient error handling
// ============================================================

describe("PolarClient", () => {
  it("throws PolarNotFoundError for 404 responses", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("<html>Not Found</html>", {
        status: 404,
        headers: { "content-type": "text/html" },
      });
    };

    const client = new PolarClient("token", mockFetch);
    await expect(client.getExercises()).rejects.toThrow(PolarNotFoundError);
  });

  it("includes endpoint path in PolarNotFoundError message", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("", { status: 404 });
    };

    const client = new PolarClient("token", mockFetch);
    await expect(client.getExercises()).rejects.toThrow("/exercises");
  });

  it("throws PolarUnauthorizedError for 401 responses", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    };

    const client = new PolarClient("token", mockFetch);
    await expect(client.getExercises()).rejects.toThrow(PolarUnauthorizedError);
  });

  it("truncates HTML error bodies instead of dumping them", async () => {
    const longHtml = `<!DOCTYPE html><html><head><title>Error</title></head><body>${"x".repeat(5000)}</body></html>`;
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response(longHtml, {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    };

    const client = new PolarClient("token", mockFetch);
    await expect(client.getExercises()).rejects.toThrow("(HTML error page)");
  });

  it("includes JSON body in error messages", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 422,
        headers: { "content-type": "application/json" },
      });
    };

    const client = new PolarClient("token", mockFetch);
    await expect(client.getExercises()).rejects.toThrow(
      'Polar API error (422): {"error":"unauthorized"}',
    );
  });

  it("parses successful JSON responses", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = new PolarClient("token", mockFetch);
    const result = await client.getExercises();
    expect(result).toEqual([]);
  });

  it("truncates long plain-text error responses", async () => {
    const longText = "x".repeat(300);
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response(longText, {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    };

    const client = new PolarClient("token", mockFetch);
    await expect(client.getExercises()).rejects.toThrow(
      `Polar API error (500): ${"x".repeat(200)}…`,
    );
  });
});

describe("PolarClient.registerUser", () => {
  it("sends POST /v3/users with member-id", async () => {
    let capturedBody: string | undefined;
    const mockFetch: typeof globalThis.fetch = async (
      _url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedBody = typeof init?.body === "string" ? init.body : undefined;
      return new Response(null, { status: 200 });
    };

    const client = new PolarClient("token", mockFetch);
    await client.registerUser("12345");

    expect(capturedBody).toBe(JSON.stringify({ "member-id": "12345" }));
  });

  it("treats 409 Conflict as success (already registered)", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Conflict", { status: 409 });
    };

    const client = new PolarClient("token", mockFetch);
    // Should not throw
    await client.registerUser("12345");
  });

  it("throws on non-2xx/non-409 responses", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Bad Request", { status: 400 });
    };

    const client = new PolarClient("token", mockFetch);
    await expect(client.registerUser("12345")).rejects.toThrow(
      "Polar user registration failed (400)",
    );
  });
});

describe("PolarClient.deregisterUser", () => {
  it("sends DELETE /v3/users/{userId}", async () => {
    let capturedUrl: string | undefined;
    let capturedMethod: string | undefined;
    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedUrl = String(url);
      capturedMethod = init?.method;
      return new Response(null, { status: 204 });
    };

    const client = new PolarClient("token", mockFetch);
    await client.deregisterUser("12345");

    expect(capturedUrl).toBe("https://www.polaraccesslink.com/v3/users/12345");
    expect(capturedMethod).toBe("DELETE");
  });

  it("treats 404 as success (already deregistered)", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Not Found", { status: 404 });
    };

    const client = new PolarClient("token", mockFetch);
    // Should not throw
    await client.deregisterUser("12345");
  });

  it("throws with truncated body on non-success responses", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Bad Request: missing field", { status: 400 });
    };

    const client = new PolarClient("token", mockFetch);
    await expect(client.deregisterUser("12345")).rejects.toThrow(
      "Polar user deregistration failed (400): Bad Request: missing field",
    );
  });

  it("truncates HTML error bodies", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("<html><body>Error</body></html>", {
        status: 500,
        headers: { "content-type": "text/html" },
      });
    };

    const client = new PolarClient("token", mockFetch);
    await expect(client.deregisterUser("12345")).rejects.toThrow(
      "Polar user deregistration failed (500): (HTML error page)",
    );
  });
});

describe("PolarClient.getCurrentUserId", () => {
  it("returns polar_user_id from GET /v3/users", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({ polar_user_id: 12345 });
    };

    const client = new PolarClient("token", mockFetch);
    expect(await client.getCurrentUserId()).toBe("12345");
  });

  it("returns null when request fails", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Unauthorized", { status: 401 });
    };

    const client = new PolarClient("token", mockFetch);
    expect(await client.getCurrentUserId()).toBeNull();
  });

  it("returns null when polar_user_id is missing from response", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({});
    };

    const client = new PolarClient("token", mockFetch);
    expect(await client.getCurrentUserId()).toBeNull();
  });
});

describe("PolarNotFoundError", () => {
  it("has correct name and message", () => {
    const error = new PolarNotFoundError("Not found");
    expect(error.name).toBe("PolarNotFoundError");
    expect(error.message).toBe("Not found");
    expect(error).toBeInstanceOf(Error);
  });
});

describe("PolarUnauthorizedError", () => {
  it("has correct name and message", () => {
    const error = new PolarUnauthorizedError("Unauthorized");
    expect(error.name).toBe("PolarUnauthorizedError");
    expect(error.message).toBe("Unauthorized");
    expect(error).toBeInstanceOf(Error);
  });
});

// ============================================================
// PolarProvider auth setup
// ============================================================

describe("PolarProvider.authSetup", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("throws when only POLAR_CLIENT_ID is set", () => {
    process.env.POLAR_CLIENT_ID = "polar-id";
    delete process.env.POLAR_CLIENT_SECRET;

    const provider = new PolarProvider();
    expect(() => provider.authSetup()).toThrow(
      "POLAR_CLIENT_ID and POLAR_CLIENT_SECRET are required",
    );
  });

  it("throws when only POLAR_CLIENT_SECRET is set", () => {
    delete process.env.POLAR_CLIENT_ID;
    process.env.POLAR_CLIENT_SECRET = "polar-secret";

    const provider = new PolarProvider();
    expect(() => provider.authSetup()).toThrow(
      "POLAR_CLIENT_ID and POLAR_CLIENT_SECRET are required",
    );
  });

  it("returns expected OAuth config fields for Polar", () => {
    process.env.POLAR_CLIENT_ID = "polar-id";
    process.env.POLAR_CLIENT_SECRET = "polar-secret";

    const provider = new PolarProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.scopes).toEqual(["accesslink.read_all"]);
    expect(setup.oauthConfig.tokenAuthMethod).toBe("basic");
  });

  it("exchangeCode uses x_user_id from token response to register with AccessLink", async () => {
    process.env.POLAR_CLIENT_ID = "polar-id";
    process.env.POLAR_CLIENT_SECRET = "polar-secret";

    const calledUrls: string[] = [];
    const registrationBodies: unknown[] = [];
    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const urlString = String(url);
      calledUrls.push(`${init?.method ?? "GET"} ${urlString}`);

      // Token exchange — includes x_user_id
      if (urlString.startsWith("https://polarremote.com/")) {
        return Response.json({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 3600,
          x_user_id: 99887766,
        });
      }

      // POST /v3/users — register user
      if (urlString.endsWith("/v3/users") && init?.method === "POST") {
        if (init.body) registrationBodies.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 200 });
      }

      return Response.json([]);
    };

    const provider = new PolarProvider(mockFetch);
    const setup = provider.authSetup();
    const tokens = await setup.exchangeCode("oauth-code");

    expect(tokens.accessToken).toBe("new-access-token");
    // Should register using x_user_id, not by calling GET /v3/users
    expect(calledUrls).toContain("POST https://www.polaraccesslink.com/v3/users");
    expect(calledUrls).not.toContain("GET https://www.polaraccesslink.com/v3/users");
    expect(registrationBodies[0]).toEqual({ "member-id": "99887766" });
  });

  it("exchangeCode throws when registration fails", async () => {
    process.env.POLAR_CLIENT_ID = "polar-id";
    process.env.POLAR_CLIENT_SECRET = "polar-secret";

    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const urlString = String(url);
      if (urlString.startsWith("https://polarremote.com/")) {
        return Response.json({
          access_token: "new-access-token",
          expires_in: 3600,
          x_user_id: 12345,
        });
      }
      // DELETE /v3/users/{id} — deregister succeeds
      if (urlString.includes("/v3/users/") && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      // POST /v3/users — registration fails
      if (urlString.endsWith("/v3/users") && init?.method === "POST") {
        return new Response("Server Error", { status: 500 });
      }
      return Response.json([]);
    };

    const provider = new PolarProvider(mockFetch);
    const setup = provider.authSetup();
    await expect(setup.exchangeCode("oauth-code")).rejects.toThrow("registration failed");
  });

  it("exchangeCode throws when token response is missing x_user_id", async () => {
    process.env.POLAR_CLIENT_ID = "polar-id";
    process.env.POLAR_CLIENT_SECRET = "polar-secret";

    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
    ): Promise<Response> => {
      const urlString = String(url);
      if (urlString.startsWith("https://polarremote.com/")) {
        return Response.json({
          access_token: "new-access-token",
          expires_in: 3600,
          // No x_user_id
        });
      }
      return Response.json([]);
    };

    const provider = new PolarProvider(mockFetch);
    const setup = provider.authSetup();
    await expect(setup.exchangeCode("oauth-code")).rejects.toThrow("missing x_user_id");
  });

  it("revokeExistingTokens deregisters user to free token slot", async () => {
    process.env.POLAR_CLIENT_ID = "polar-id";
    process.env.POLAR_CLIENT_SECRET = "polar-secret";

    const calledUrls: string[] = [];
    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const urlString = String(url);
      calledUrls.push(`${init?.method ?? "GET"} ${urlString}`);

      // GET /v3/users — discover user ID
      if (urlString.endsWith("/v3/users") && (!init?.method || init.method === "GET")) {
        return Response.json({ polar_user_id: 12345 });
      }

      // DELETE /v3/users/12345 — deregister
      if (urlString.includes("/v3/users/12345") && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }

      return Response.json([]);
    };

    const provider = new PolarProvider(mockFetch);
    const setup = provider.authSetup();
    if (!setup.revokeExistingTokens) {
      throw new Error("Expected revokeExistingTokens to be defined");
    }

    await setup.revokeExistingTokens({
      accessToken: "old-access-token",
      refreshToken: null,
      expiresAt: new Date("2027-01-01"),
      scopes: "accesslink.read_all",
    });

    expect(calledUrls).toContain("DELETE https://www.polaraccesslink.com/v3/users/12345");
  });

  it("revokeExistingTokens does not throw when old token is rejected", async () => {
    process.env.POLAR_CLIENT_ID = "polar-id";
    process.env.POLAR_CLIENT_SECRET = "polar-secret";

    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return new Response("Unauthorized", { status: 401 });
    };

    const provider = new PolarProvider(mockFetch);
    const setup = provider.authSetup();
    if (!setup.revokeExistingTokens) {
      throw new Error("Expected revokeExistingTokens to be defined");
    }

    // Should not throw — revocation is best-effort
    await setup.revokeExistingTokens({
      accessToken: "dead-token",
      refreshToken: null,
      expiresAt: new Date("2020-01-01"),
      scopes: null,
    });
  });
});

// ============================================================
// PolarProvider.sync error handling
// ============================================================

const POLAR_VALID_TOKEN: {
  providerId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: null;
} = {
  providerId: "polar",
  accessToken: "polar-access-token",
  refreshToken: "polar-refresh-token",
  expiresAt: new Date("2099-01-01"),
  scopes: null,
};

function createPolarMockDb(tokenRows = [POLAR_VALID_TOKEN]): SyncDatabase {
  const mockSessionId = "mock-session-id";
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(tokenRows),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation(() => {
        const onConflictDoUpdate = vi.fn().mockImplementation(() =>
          Object.assign(Promise.resolve(), {
            returning: vi.fn().mockResolvedValue([{ id: mockSessionId }]),
          }),
        );
        return Object.assign(Promise.resolve(), {
          onConflictDoUpdate,
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          returning: vi.fn().mockResolvedValue([{ id: mockSessionId }]),
        });
      }),
    }),
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    execute: vi.fn().mockResolvedValue([]),
  };
}

function createPolarFetchWithEndpointStatus(
  endpointStatus: Partial<
    Record<"/exercises" | "/sleep" | "/activity" | "/nightly-recharge", number>
  >,
): typeof globalThis.fetch {
  return async (url: string | URL | Request): Promise<Response> => {
    const urlString = String(url);
    const endpoints = ["/exercises", "/sleep", "/activity", "/nightly-recharge"] as const;
    const endpoint = endpoints.find((path) => urlString.endsWith(path));
    if (!endpoint) return Response.json([]);
    const status = endpointStatus[endpoint] ?? 200;
    if (status === 200) return Response.json([]);
    return new Response(status === 404 ? "Not Found" : "Unauthorized", { status });
  };
}

function getAuthorizationHeader(init?: RequestInit): string {
  const headers = init?.headers;
  if (!headers) return "";

  if (headers instanceof Headers) {
    return headers.get("Authorization") ?? "";
  }

  if (Array.isArray(headers)) {
    const match = headers.find(([headerName]) => headerName.toLowerCase() === "authorization");
    return match?.[1] ?? "";
  }

  if (typeof headers === "object") {
    const upperCaseKey = Reflect.get(headers, "Authorization");
    if (typeof upperCaseKey === "string") return upperCaseKey;
    const lowerCaseKey = Reflect.get(headers, "authorization");
    if (typeof lowerCaseKey === "string") return lowerCaseKey;
  }

  return "";
}

function getPayloadProviderId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("providerId" in value)) return undefined;
  const providerId = Reflect.get(value, "providerId");
  return typeof providerId === "string" ? providerId : undefined;
}

describe("PolarProvider.sync — error handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refreshes expired Polar tokens before calling API endpoints", async () => {
    process.env.POLAR_CLIENT_ID = "polar-client-id";
    process.env.POLAR_CLIENT_SECRET = "polar-client-secret";

    const tokenEndpointCalls: string[] = [];
    const activityEndpointAuthorizations: string[] = [];
    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const urlString = String(url);
      if (urlString === "https://polarremote.com/v2/oauth2/token") {
        tokenEndpointCalls.push(urlString);
        return Response.json({
          access_token: "refreshed-polar-token",
          refresh_token: "refreshed-polar-refresh",
          expires_in: 3600,
          scope: "accesslink.read_all",
        });
      }
      if (urlString.endsWith("/exercises")) {
        const authorization = getAuthorizationHeader(init);
        activityEndpointAuthorizations.push(authorization);
        if (authorization !== "Bearer refreshed-polar-token") {
          return new Response("Unauthorized", { status: 401 });
        }
        return Response.json([]);
      }
      if (urlString.endsWith("/sleep")) return Response.json([]);
      if (urlString.endsWith("/activity")) return Response.json([]);
      if (urlString.endsWith("/nightly-recharge")) return Response.json([]);
      return Response.json([]);
    };

    const expiredTokenRows = [
      {
        ...POLAR_VALID_TOKEN,
        accessToken: "expired-polar-token",
        refreshToken: "expired-polar-refresh",
        expiresAt: new Date("2000-01-01T00:00:00Z"),
      },
    ];

    const provider = new PolarProvider(mockFetch);
    const result = await provider.sync(createPolarMockDb(expiredTokenRows), new Date("2026-01-01"));

    expect(tokenEndpointCalls).toHaveLength(1);
    expect(activityEndpointAuthorizations).toContain("Bearer refreshed-polar-token");
    expect(result.errors).toHaveLength(0);
  });

  it("captures unauthorized exercises endpoint errors with auth guidance", async () => {
    const provider = new PolarProvider(createPolarFetchWithEndpointStatus({ "/exercises": 401 }));
    const result = await provider.sync(createPolarMockDb(), new Date("2026-01-01"));

    expect(
      result.errors.some((e) => e.message.includes("authorization failed while syncing exercises")),
    ).toBe(true);
  });

  it("captures 404 exercises endpoint errors with re-auth guidance", async () => {
    const provider = new PolarProvider(createPolarFetchWithEndpointStatus({ "/exercises": 404 }));
    const result = await provider.sync(createPolarMockDb(), new Date("2026-01-01"));

    expect(result.errors.some((e) => e.message.includes("exercises endpoint returned 404"))).toBe(
      true,
    );
  });

  it("captures unauthorized sleep endpoint errors with auth guidance", async () => {
    const provider = new PolarProvider(createPolarFetchWithEndpointStatus({ "/sleep": 401 }));
    const result = await provider.sync(createPolarMockDb(), new Date("2026-01-01"));

    expect(
      result.errors.some((e) => e.message.includes("authorization failed while syncing sleep")),
    ).toBe(true);
  });

  it("captures 404 sleep endpoint errors with re-auth guidance", async () => {
    const provider = new PolarProvider(createPolarFetchWithEndpointStatus({ "/sleep": 404 }));
    const result = await provider.sync(createPolarMockDb(), new Date("2026-01-01"));

    expect(result.errors.some((e) => e.message.includes("sleep endpoint returned 404"))).toBe(true);
  });

  it("captures unauthorized daily activity endpoint errors with auth guidance", async () => {
    const provider = new PolarProvider(createPolarFetchWithEndpointStatus({ "/activity": 401 }));
    const result = await provider.sync(createPolarMockDb(), new Date("2026-01-01"));

    expect(
      result.errors.some((e) =>
        e.message.includes("authorization failed while syncing daily activity"),
      ),
    ).toBe(true);
  });

  it("captures 404 daily activity endpoint errors with re-auth guidance", async () => {
    const provider = new PolarProvider(createPolarFetchWithEndpointStatus({ "/activity": 404 }));
    const result = await provider.sync(createPolarMockDb(), new Date("2026-01-01"));

    expect(
      result.errors.some((e) => e.message.includes("daily activity endpoint returned 404")),
    ).toBe(true);
  });

  it("returns a token error when no Polar tokens are stored", async () => {
    const provider = new PolarProvider(createPolarFetchWithEndpointStatus({}));
    const result = await provider.sync(createPolarMockDb([]), new Date("2026-01-01"));

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens found for Polar");
  });

  it("syncs exercises, sleep, and daily activity on happy path", async () => {
    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
    ): Promise<Response> => {
      const urlString = String(url);
      if (urlString.endsWith("/exercises")) return Response.json([sampleExercise]);
      if (urlString.endsWith("/sleep")) return Response.json([sampleSleep]);
      if (urlString.endsWith("/activity")) return Response.json([sampleDailyActivity]);
      if (urlString.endsWith("/nightly-recharge")) return Response.json([sampleNightlyRecharge]);
      return Response.json([]);
    };

    const provider = new PolarProvider(mockFetch);
    const result = await provider.sync(createPolarMockDb(), new Date("2024-01-01"));

    expect(result.recordsSynced).toBe(3);
    expect(result.errors).toHaveLength(0);
  });

  it("captures generic API failures for each Polar data type", async () => {
    const provider = new PolarProvider(
      createPolarFetchWithEndpointStatus({
        "/exercises": 500,
        "/sleep": 500,
        "/activity": 500,
      }),
    );
    const result = await provider.sync(createPolarMockDb(), new Date("2026-01-01"));

    expect(result.errors.some((e) => e.message.startsWith("exercises: "))).toBe(true);
    expect(result.errors.some((e) => e.message.startsWith("sleep: "))).toBe(true);
    expect(result.errors.some((e) => e.message.startsWith("daily_activity: "))).toBe(true);
  });

  it("captures per-record insert failures for exercises, sleep, and daily metrics", async () => {
    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
    ): Promise<Response> => {
      const urlString = String(url);
      if (urlString.endsWith("/exercises")) return Response.json([sampleExercise]);
      if (urlString.endsWith("/sleep")) return Response.json([sampleSleep]);
      if (urlString.endsWith("/activity")) return Response.json([sampleDailyActivity]);
      if (urlString.endsWith("/nightly-recharge")) return Response.json([sampleNightlyRecharge]);
      return Response.json([]);
    };

    const failingDb: SyncDatabase = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([POLAR_VALID_TOKEN]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((payload: unknown) => {
          if (getPayloadProviderId(payload) === "polar") {
            return {
              onConflictDoUpdate: vi.fn().mockRejectedValue(new Error("forced insert failure")),
            };
          }
          return Object.assign(Promise.resolve(), {
            onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
            onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
            returning: vi.fn().mockResolvedValue([{ id: "activity-row-id" }]),
          });
        }),
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const provider = new PolarProvider(mockFetch);
    const result = await provider.sync(failingDb, new Date("2024-01-01"));

    expect(result.errors.some((e) => e.message.startsWith("Exercise "))).toBe(true);
    expect(result.errors.some((e) => e.message.startsWith("Sleep "))).toBe(true);
    expect(result.errors.some((e) => e.message.startsWith("Daily "))).toBe(true);
  });

  it("uses existing token when expired with no refresh token (Polar tokens are long-lived)", async () => {
    process.env.POLAR_CLIENT_ID = "polar-client-id";
    process.env.POLAR_CLIENT_SECRET = "polar-client-secret";

    const apiCallAuthorizations: string[] = [];
    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const urlString = String(url);
      // Should NOT call the token refresh endpoint
      if (urlString.startsWith("https://polarremote.com/")) {
        throw new Error("Should not attempt token refresh when no refresh token exists");
      }
      const authorization = getAuthorizationHeader(init);
      apiCallAuthorizations.push(authorization);
      return Response.json([]);
    };

    const expiredNoRefreshToken = [
      {
        providerId: "polar",
        accessToken: "polar-long-lived-token",
        refreshToken: null, // No refresh token — Polar tokens are long-lived
        expiresAt: new Date("2020-01-01T00:00:00Z"), // Past expiry
        scopes: null,
      },
    ];

    const provider = new PolarProvider(mockFetch);
    const result = await provider.sync(
      createPolarMockDb(expiredNoRefreshToken),
      new Date("2026-01-01"),
    );

    // Should succeed using the existing token, not fail with "No refresh token"
    expect(result.errors).toHaveLength(0);
    expect(apiCallAuthorizations).toContain("Bearer polar-long-lived-token");
  });

  it("syncs daily activity even when nightly recharge endpoint fails", async () => {
    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
    ): Promise<Response> => {
      const urlString = String(url);
      if (urlString.endsWith("/exercises")) return Response.json([]);
      if (urlString.endsWith("/sleep")) return Response.json([]);
      if (urlString.endsWith("/activity")) return Response.json([sampleDailyActivity]);
      if (urlString.endsWith("/nightly-recharge"))
        return new Response("Not Found", { status: 404 });
      return Response.json([]);
    };

    const provider = new PolarProvider(mockFetch);
    const result = await provider.sync(createPolarMockDb(), new Date("2024-01-01"));

    // Daily activity should still be synced even though nightly recharge failed
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);
    // Should not have a fatal error for daily_activity
    expect(
      result.errors.some((e) => e.message.includes("daily activity endpoint returned 404")),
    ).toBe(false);
  });

  it("deletes tokens and reports revocation when refresh returns invalid_grant", async () => {
    process.env.POLAR_CLIENT_ID = "polar-client-id";
    process.env.POLAR_CLIENT_SECRET = "polar-client-secret";

    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
    ): Promise<Response> => {
      const urlString = String(url);
      if (urlString.startsWith("https://polarremote.com/")) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return Response.json([]);
    };

    const expiredWithRefresh = [
      {
        providerId: "polar",
        accessToken: "expired-token",
        refreshToken: "revoked-refresh-token",
        expiresAt: new Date("2020-01-01T00:00:00Z"),
        scopes: null,
      },
    ];

    const mockDb = createPolarMockDb(expiredWithRefresh);
    const provider = new PolarProvider(mockFetch);
    const result = await provider.sync(mockDb, new Date("2026-01-01"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("authorization revoked");
  });

  it("deletes tokens and skips remaining sections when API returns 401", async () => {
    const calledEndpoints: string[] = [];
    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
    ): Promise<Response> => {
      const urlString = String(url);
      const endpoints = ["/exercises", "/sleep", "/activity", "/nightly-recharge"] as const;
      const endpoint = endpoints.find((path) => urlString.endsWith(path));
      if (endpoint) calledEndpoints.push(endpoint);
      if (urlString.endsWith("/exercises")) {
        return new Response("Unauthorized", { status: 401 });
      }
      return Response.json([]);
    };

    const mockDb = createPolarMockDb();
    const provider = new PolarProvider(mockFetch);
    const result = await provider.sync(mockDb, new Date("2026-01-01"));

    // Should have only attempted exercises, not sleep or activity
    expect(calledEndpoints).toEqual(["/exercises"]);
    // Should report the auth error
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("authorization failed");
    // Should have deleted the stored tokens
    expect(mockDb.delete).toHaveBeenCalled();
  });

  it("deletes tokens when a later section returns 401", async () => {
    const calledEndpoints: string[] = [];
    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
    ): Promise<Response> => {
      const urlString = String(url);
      const endpoints = ["/exercises", "/sleep", "/activity", "/nightly-recharge"] as const;
      const endpoint = endpoints.find((path) => urlString.endsWith(path));
      if (endpoint) calledEndpoints.push(endpoint);
      if (urlString.endsWith("/activity")) {
        return new Response("Unauthorized", { status: 401 });
      }
      return Response.json([]);
    };

    const mockDb = createPolarMockDb();
    const provider = new PolarProvider(mockFetch);
    const result = await provider.sync(mockDb, new Date("2026-01-01"));

    // Should have attempted exercises, sleep, and activity (but not nightly-recharge after 401)
    expect(calledEndpoints).toContain("/exercises");
    expect(calledEndpoints).toContain("/sleep");
    expect(calledEndpoints).toContain("/activity");
    // Should report the auth error and delete tokens
    expect(result.errors.some((error) => error.message.includes("authorization failed"))).toBe(
      true,
    );
    expect(mockDb.delete).toHaveBeenCalled();
  });
});
