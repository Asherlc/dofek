import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { describe, expect, it, vi } from "vitest";
import { VeloHeroClient } from "./client.ts";
import type { VeloHeroSsoResponse, VeloHeroWorkout, VeloHeroWorkoutsResponse } from "./types.ts";

function rateLimitedFetch(retryAfterSeconds: string): typeof globalThis.fetch {
  return async () =>
    new Response("Too Many Requests", {
      status: 429,
      headers: { "Retry-After": retryAfterSeconds },
    });
}

type TypedMockFetch = ReturnType<typeof vi.fn<typeof globalThis.fetch>> & typeof globalThis.fetch;

function mockFetch(response: { status: number; ok: boolean; body: unknown }): TypedMockFetch {
  const text = typeof response.body === "string" ? response.body : JSON.stringify(response.body);
  const mockResponse = new Response(text, { status: response.status });
  Object.defineProperty(mockResponse, "json", {
    value: () => Promise.resolve(response.body),
    configurable: true,
  });
  Object.defineProperty(mockResponse, "ok", { value: response.ok, configurable: true });
  const fn = vi.fn<typeof globalThis.fetch>();
  fn.mockResolvedValue(mockResponse);
  return fn;
}

describe("VeloHeroClient.signIn", () => {
  it("returns sessionCookie and userId on success", async () => {
    const ssoResponse: VeloHeroSsoResponse = {
      session: "abc123session",
      "user-id": "user-42",
    };

    const fetchFn = mockFetch({ status: 200, ok: true, body: ssoResponse });

    const result = await VeloHeroClient.signIn("testuser", "password123", fetchFn);

    expect(result).toEqual({
      sessionCookie: "VeloHero_session=abc123session",
      userId: "user-42",
    });

    const url = fetchFn.mock.calls[0]?.[0];
    const options = fetchFn.mock.calls[0]?.[1];
    expect(url).toBe("https://app.velohero.com/sso");
    expect(options?.method).toBe("POST");
    expect(options?.redirect).toBe("manual");
    const headers = new Headers(options?.headers);
    expect(headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
  });

  it("throws on non-200 response", async () => {
    const fetchFn = mockFetch({ status: 401, ok: false, body: "Invalid credentials" });

    await expect(VeloHeroClient.signIn("testuser", "wrong-password", fetchFn)).rejects.toThrow(
      "VeloHero sign-in failed (401)",
    );
  });

  it("throws when no session token is returned", async () => {
    const ssoResponse = { session: "", "user-id": "user-42" };
    const fetchFn = mockFetch({ status: 200, ok: true, body: ssoResponse });

    await expect(VeloHeroClient.signIn("testuser", "password123", fetchFn)).rejects.toThrow(
      "VeloHero sign-in did not return a session token",
    );
  });

  it("throws a velohero-scoped ProviderRateLimitError on 429", async () => {
    const error = await VeloHeroClient.signIn(
      "testuser",
      "password123",
      rateLimitedFetch("30"),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(error).toHaveProperty("providerId", "velohero");
    expect(error).toHaveProperty("retryAfterSeconds", 30);
  });
});

describe("VeloHeroClient instance rate limit detection", () => {
  it("throws a velohero-scoped ProviderRateLimitError on 429", async () => {
    const client = new VeloHeroClient("VeloHero_session=abc123", rateLimitedFetch("15"));

    const error = await client
      .getWorkouts("2024-01-01", "2024-01-31")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(error).toHaveProperty("providerId", "velohero");
    expect(error).toHaveProperty("retryAfterSeconds", 15);
  });
});

describe("VeloHeroClient.getWorkouts", () => {
  it("returns workouts on success", async () => {
    const workouts: VeloHeroWorkout[] = [
      {
        id: "1001",
        date_ymd: "2024-01-15",
        start_time: "08:00:00",
        dur_time: "01:30:00",
        sport_id: "1",
        dist_km: "42.5",
        title: "Morning ride",
        avg_hr: "145",
        max_hr: "175",
        avg_power: "200",
        max_power: "350",
      },
    ];
    const response: VeloHeroWorkoutsResponse = { workouts };

    const fetchFn = mockFetch({ status: 200, ok: true, body: response });
    const client = new VeloHeroClient("VeloHero_session=abc123", fetchFn);

    const result = await client.getWorkouts("2024-01-01", "2024-01-31");

    expect(result).toEqual(workouts);
    const url = fetchFn.mock.calls[0]?.[0];
    const options = fetchFn.mock.calls[0]?.[1];
    expect(url).toContain("https://app.velohero.com/export/workouts/json");
    expect(url).toContain("date_from=2024-01-01");
    expect(url).toContain("date_to=2024-01-31");
    const headers = new Headers(options?.headers);
    expect(headers.get("Cookie")).toBe("VeloHero_session=abc123");
  });

  it("returns empty array when workouts is undefined", async () => {
    const response = {};
    const fetchFn = mockFetch({ status: 200, ok: true, body: response });
    const client = new VeloHeroClient("VeloHero_session=abc123", fetchFn);

    const result = await client.getWorkouts("2024-01-01", "2024-01-31");

    expect(result).toEqual([]);
  });

  it("throws on non-200 response", async () => {
    const fetchFn = mockFetch({ status: 500, ok: false, body: "Server Error" });
    const client = new VeloHeroClient("VeloHero_session=abc123", fetchFn);

    await expect(client.getWorkouts("2024-01-01", "2024-01-31")).rejects.toThrow(
      "VeloHero API error (500)",
    );
  });
});

describe("VeloHeroClient.getWorkout", () => {
  it("returns a single workout on success", async () => {
    const workout: VeloHeroWorkout = {
      id: "1001",
      date_ymd: "2024-01-15",
      start_time: "08:00:00",
      dur_time: "01:30:00",
      sport_id: "1",
      dist_km: "42.5",
    };

    const fetchFn = mockFetch({ status: 200, ok: true, body: workout });
    const client = new VeloHeroClient("VeloHero_session=abc123", fetchFn);

    const result = await client.getWorkout("1001");

    expect(result).toEqual(workout);
    const url = fetchFn.mock.calls[0]?.[0];
    expect(url).toBe("https://app.velohero.com/export/workouts/json/1001");
  });
});
