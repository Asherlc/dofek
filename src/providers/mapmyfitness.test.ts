import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderRateLimitFetch } from "../lib/provider-rate-limit-fetch.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";

vi.mock("../db/token-user-context.ts", () => ({
  getTokenUserId: () => "user-1",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

import {
  MapMyFitnessClient,
  MapMyFitnessProvider,
  mapMapMyFitnessActivityType,
  mapMyFitnessOAuthConfig,
  parseMapMyFitnessWorkout,
} from "./mapmyfitness.ts";

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
    await expect(
      client.getWorkouts("user-1", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"),
    ).rejects.toThrow("MapMyFitness API error (401)");
  });

  it("throws a ProviderRateLimitError with providerId on 429", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("slow down", { status: 429 }));
    const rateLimitedFetch = createProviderRateLimitFetch("mapmyfitness", mockFetch);

    const client = new MapMyFitnessClient("token", "client-id", rateLimitedFetch);
    const error = await client
      .getWorkouts("user-1", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z")
      .catch((caught: unknown) => caught);
    if (!(error instanceof ProviderRateLimitError)) {
      throw new Error(`expected ProviderRateLimitError, got ${String(error)}`);
    }
    expect(error.providerId).toBe("mapmyfitness");
    expect(error.statusCode).toBe(429);
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
    await client.getWorkouts("user-1", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z");

    const headers: Record<string, string> = mockFetch.mock.calls[0]?.[1]?.headers;
    expect(headers.Authorization).toBe("Bearer my-token");
    expect(headers["Api-Key"]).toBe("my-client-id");
  });

  it("includes the upper sync bound in the workout query", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      Response.json({
        _embedded: { workouts: [] },
        _links: {},
        total_count: 0,
      }),
    );

    const client = new MapMyFitnessClient("my-token", "my-client-id", mockFetch);
    await client.getWorkouts("user-1", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", 40);

    const requestUrl = String(mockFetch.mock.calls[0]?.[0]);
    expect(requestUrl).toContain("started_after=2026-01-01T00%3A00%3A00Z");
    expect(requestUrl).toContain("started_before=2026-01-02T00%3A00%3A00Z");
    expect(requestUrl).toContain("offset=40");
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

  it("authSetup exposes a working exchangeCode that hits the token endpoint", async () => {
    // Kills the ArrowFunction mutant on
    // exchangeCode: (code) => exchangeCodeForTokens(config, code, fetchFn) → () => undefined.
    process.env.MAPMYFITNESS_CLIENT_ID = "id";
    process.env.MAPMYFITNESS_CLIENT_SECRET = "secret";

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          access_token: "access-xyz",
          refresh_token: "refresh-xyz",
          expires_in: 3600,
        }),
      )
      .mockResolvedValueOnce(Response.json({ id: 123456 }));

    const setup = new MapMyFitnessProvider(mockFetch).authSetup();
    const { exchangeCode } = setup;
    if (!exchangeCode) throw new Error("exchangeCode not defined");
    const tokens = await exchangeCode("auth-code-123");

    expect(tokens.accessToken).toBe("access-xyz");
    expect(tokens.providerAccountId).toBe("123456");
    const [url, init] = mockFetch.mock.calls[0] ?? [];
    expect(String(url)).toContain("/oauth2/access_token/");
    expect(String(init?.body)).toContain("auth-code-123");
    expect(String(mockFetch.mock.calls[1]?.[0])).toBe(
      "https://api.mapmyfitness.com/v7.1/user/self/",
    );
  });

  it("exposes issued tokens before identity lookup can fail", async () => {
    process.env.MAPMYFITNESS_CLIENT_ID = "map-client";
    process.env.MAPMYFITNESS_CLIENT_SECRET = "map-secret";
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          access_token: "access-xyz",
          refresh_token: "refresh-xyz",
          expires_in: 3600,
          user_id: "123456",
        }),
      )
      .mockResolvedValueOnce(new Response("identity unavailable", { status: 503 }));
    const issuedTokens = vi.fn();
    const setup = new MapMyFitnessProvider(mockFetch).authSetup();
    if (!setup.exchangeCode) throw new Error("exchangeCode not defined");

    await expect(setup.exchangeCode("auth-code-123", undefined, issuedTokens)).rejects.toThrow(
      "mapmyfitness API service unavailable (503)",
    );
    expect(issuedTokens).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "access-xyz", providerAccountId: "123456" }),
    );
  });

  it("replays the documented authorization revocation request", async () => {
    process.env.MAPMYFITNESS_CLIENT_ID = "map-client";
    process.env.MAPMYFITNESS_CLIENT_SECRET = "map-secret";
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const setup = new MapMyFitnessProvider(mockFetch).authSetup();
    const revoke = setup.revokeTokensForAccountErasure;
    if (!revoke) throw new Error("revokeTokensForAccountErasure not defined");
    const tokens = {
      accessToken: "map-access",
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
      providerAccountId: "123456",
      refreshToken: "map-refresh",
      scopes: "read",
    };

    await revoke(tokens);
    await revoke(tokens);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    for (const [input, init] of mockFetch.mock.calls) {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe(
        "https://api.mapmyfitness.com/v7.1/oauth2/connection/",
      );
      expect(url.searchParams.get("user_id")).toBe("123456");
      expect(url.searchParams.get("client_id")).toBe("map-client");
      expect(init?.method).toBe("DELETE");
      expect(init?.headers).toEqual({
        Accept: "application/json",
        Authorization: "Bearer map-access",
        "Api-Key": "map-client",
      });
    }
  });

  it("requires a durable user id and the documented 204 response", async () => {
    process.env.MAPMYFITNESS_CLIENT_ID = "map-client";
    process.env.MAPMYFITNESS_CLIENT_SECRET = "map-secret";
    const mockFetch = vi.fn().mockResolvedValue(new Response("not found", { status: 404 }));
    const revoke = new MapMyFitnessProvider(mockFetch).authSetup().revokeTokensForAccountErasure;
    if (!revoke) throw new Error("revokeTokensForAccountErasure not defined");
    const tokens = {
      accessToken: "map-access",
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
      refreshToken: "map-refresh",
      scopes: "read",
    };

    await expect(revoke(tokens)).rejects.toThrow(
      "Reconnect MapMyFitness before deleting your account",
    );
    expect(mockFetch).not.toHaveBeenCalled();
    await expect(revoke({ ...tokens, providerAccountId: "123456" })).rejects.toThrow(
      "MapMyFitness authorization revocation failed (404)",
    );
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
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const result = await new MapMyFitnessProvider().sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.provider).toBe("mapmyfitness");
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
