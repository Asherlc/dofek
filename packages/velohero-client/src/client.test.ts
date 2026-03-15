import { describe, expect, it, vi } from "vitest";
import { VeloHeroClient } from "./client.ts";
import type { VeloHeroSsoResponse, VeloHeroWorkout, VeloHeroWorkoutsResponse } from "./types.ts";

type MockFetchFn = ReturnType<typeof vi.fn>;

function mockFetch(
  response: { status: number; ok: boolean; body: unknown },
): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    json: () => Promise.resolve(response.body),
    text: () => Promise.resolve(typeof response.body === "string" ? response.body : JSON.stringify(response.body)),
  });
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

    const [url, options] = (fetchFn as MockFetchFn).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://app.velohero.com/sso");
    expect(options.method).toBe("POST");
    expect(options.redirect).toBe("manual");
    const headers = options.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("throws on non-200 response", async () => {
    const fetchFn = mockFetch({ status: 401, ok: false, body: "Invalid credentials" });

    await expect(
      VeloHeroClient.signIn("testuser", "wrong-password", fetchFn),
    ).rejects.toThrow("VeloHero sign-in failed (401)");
  });

  it("throws when no session token is returned", async () => {
    const ssoResponse = { session: "", "user-id": "user-42" };
    const fetchFn = mockFetch({ status: 200, ok: true, body: ssoResponse });

    await expect(
      VeloHeroClient.signIn("testuser", "password123", fetchFn),
    ).rejects.toThrow("VeloHero sign-in did not return a session token");
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
    const [url, options] = (fetchFn as MockFetchFn).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("https://app.velohero.com/export/workouts/json");
    expect(url).toContain("date_from=2024-01-01");
    expect(url).toContain("date_to=2024-01-31");
    const headers = options.headers as Record<string, string>;
    expect(headers.Cookie).toBe("VeloHero_session=abc123");
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

    await expect(
      client.getWorkouts("2024-01-01", "2024-01-31"),
    ).rejects.toThrow("VeloHero API error (500)");
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
    const [url] = (fetchFn as MockFetchFn).mock.calls[0] as [string];
    expect(url).toBe("https://app.velohero.com/export/workouts/json/1001");
  });
});
