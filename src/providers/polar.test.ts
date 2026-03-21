import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../db/index.ts";
import {
  mapPolarSport,
  PolarClient,
  type PolarDailyActivity,
  type PolarExercise,
  type PolarNightlyRecharge,
  PolarNotFoundError,
  PolarProvider,
  type PolarSleep,
  PolarUnauthorizedError,
  parsePolarDailyActivity,
  parsePolarDuration,
  parsePolarExercise,
  parsePolarSleep,
} from "./polar.ts";

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

  it("exchangeCode function returns a token response promise", async () => {
    process.env.POLAR_CLIENT_ID = "polar-id";
    process.env.POLAR_CLIENT_SECRET = "polar-secret";

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
      }),
    );

    const provider = new PolarProvider();
    const setup = provider.authSetup();
    const tokens = await setup.exchangeCode("oauth-code");

    expect(fetchMock).toHaveBeenCalled();
    expect(tokens.accessToken).toBe("new-access-token");
  });
});

// ============================================================
// PolarProvider.sync error handling
// ============================================================

const POLAR_VALID_TOKEN = {
  providerId: "polar",
  accessToken: "polar-access-token",
  refreshToken: "polar-refresh-token",
  expiresAt: new Date("2099-01-01"),
  scopes: null,
};

function createPolarMockDb(tokenRows = [POLAR_VALID_TOKEN]): SyncDatabase {
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

function getPayloadProviderId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("providerId" in value)) return undefined;
  const providerId = Reflect.get(value, "providerId");
  return typeof providerId === "string" ? providerId : undefined;
}

describe("PolarProvider.sync — error handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
});
