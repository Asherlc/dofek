import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { describe, expect, it, vi } from "vitest";
import { TrainerRoadClient } from "./client.ts";
import type { TrainerRoadActivity, TrainerRoadMemberInfo } from "./types.ts";

async function expectTrainerRoadRateLimitError(
  action: () => Promise<unknown>,
  retryAfterSeconds: number,
) {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(error).toMatchObject({ providerId: "trainerroad", retryAfterSeconds });
    return;
  }

  throw new Error("Expected TrainerRoad rate-limit error");
}

function mockFetch(response: {
  status: number;
  ok: boolean;
  body: unknown;
  headers?: Record<string, string[]>;
}): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    json: () => Promise.resolve(response.body),
    text: () =>
      Promise.resolve(
        typeof response.body === "string" ? response.body : JSON.stringify(response.body),
      ),
    headers: {
      getSetCookie: () => response.headers?.["Set-Cookie"] ?? [],
    },
  });
}

describe("TrainerRoadClient.signIn", () => {
  it("returns authCookie and username on success", async () => {
    const memberInfo: TrainerRoadMemberInfo = {
      MemberId: 42,
      Username: "testuser",
    };

    const csrfHtml = '<input name="__RequestVerificationToken" value="csrf-token-123" />';
    const callCount = { value: 0 };

    const fetchFn = vi.fn().mockImplementation(() => {
      callCount.value++;
      if (callCount.value === 1) {
        // GET login page (for CSRF + cookies)
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(csrfHtml),
          headers: {
            getSetCookie: () => ["ASP.NET_SessionId=abc123; path=/"],
          },
        });
      }
      if (callCount.value === 2) {
        // POST login
        return Promise.resolve({
          ok: true,
          status: 302,
          text: () => Promise.resolve(""),
          headers: {
            getSetCookie: () => ["SharedTrainerRoadAuth=auth-cookie-value; path=/; HttpOnly"],
          },
        });
      }
      // GET member info
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(memberInfo),
        text: () => Promise.resolve(JSON.stringify(memberInfo)),
      });
    });

    const result = await TrainerRoadClient.signIn("testuser", "password123", fetchFn);

    expect(result).toEqual({
      authCookie: "auth-cookie-value",
      username: "testuser",
    });
  });

  it("throws when no auth cookie is returned", async () => {
    const csrfHtml = '<input name="__RequestVerificationToken" value="csrf-token-123" />';
    const callCount = { value: 0 };

    const fetchFn = vi.fn().mockImplementation(() => {
      callCount.value++;
      if (callCount.value === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(csrfHtml),
          headers: {
            getSetCookie: () => ["ASP.NET_SessionId=abc123; path=/"],
          },
        });
      }
      // POST login — no auth cookie
      return Promise.resolve({
        ok: true,
        status: 302,
        text: () => Promise.resolve(""),
        headers: {
          getSetCookie: () => [],
        },
      });
    });

    await expect(TrainerRoadClient.signIn("testuser", "wrong-password", fetchFn)).rejects.toThrow(
      "TrainerRoad login failed",
    );
  });

  it("throws the common rate-limit error when login is throttled", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response("retry later", { status: 429, headers: { "Retry-After": "120" } });

    await expectTrainerRoadRateLimitError(
      () => TrainerRoadClient.signIn("testuser", "password123", fetchFn),
      120,
    );
  });
});

describe("TrainerRoadClient.getActivities", () => {
  it("returns activities on success", async () => {
    const activities: TrainerRoadActivity[] = [
      {
        Id: 1,
        WorkoutName: "Ramp Test",
        CompletedDate: "2024-01-15T10:00:00Z",
        Duration: 1200,
        Tss: 45,
        DistanceInMeters: 15000,
        IsOutside: false,
        ActivityType: "Ride",
        IfFactor: 0.85,
        NormalizedPower: 220,
        AveragePower: 200,
        MaxPower: 350,
        AverageHeartRate: 145,
        MaxHeartRate: 175,
        AverageCadence: 90,
        MaxCadence: 110,
        Calories: 500,
        ElevationGainInMeters: 0,
        AverageSpeed: 12.5,
        MaxSpeed: 15.0,
      },
    ];

    const fetchFn = mockFetch({ status: 200, ok: true, body: activities });
    const client = new TrainerRoadClient("test-auth-cookie", fetchFn);

    const result = await client.getActivities("testuser", "2024-01-01", "2024-01-31");

    expect(result).toEqual(activities);
    const [url, options]: [string, RequestInit] = fetchFn.mock.calls[0];
    expect(url).toContain("/app/api/calendar/activities/testuser");
    expect(url).toContain("startDate=2024-01-01");
    expect(url).toContain("endDate=2024-01-31");
    const headers: Record<string, string> = options.headers;
    expect(headers.Cookie).toBe("SharedTrainerRoadAuth=test-auth-cookie");
  });

  it("throws on non-200 response", async () => {
    const fetchFn = mockFetch({ status: 403, ok: false, body: "Forbidden" });
    const client = new TrainerRoadClient("test-auth-cookie", fetchFn);

    await expect(client.getActivities("testuser", "2024-01-01", "2024-01-31")).rejects.toThrow(
      "TrainerRoad API error (403)",
    );
  });

  it("throws the common rate-limit error when the API is throttled", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response("too many requests", { status: 429, headers: { "Retry-After": "30" } });
    const client = new TrainerRoadClient("test-auth-cookie", fetchFn);

    await expectTrainerRoadRateLimitError(
      () => client.getActivities("testuser", "2024-01-01", "2024-01-31"),
      30,
    );
  });
});

describe("TrainerRoadClient.getCareer", () => {
  it("returns career data on success", async () => {
    const career = { Ftp: 250, Weight: 72 };
    const fetchFn = mockFetch({ status: 200, ok: true, body: career });
    const client = new TrainerRoadClient("test-auth-cookie", fetchFn);

    const result = await client.getCareer("testuser");

    expect(result).toEqual(career);
    const [url]: [string] = fetchFn.mock.calls[0];
    expect(url).toContain("/app/api/career/testuser/new");
  });
});

describe("TrainerRoadClient.getMemberInfo", () => {
  it("returns member info on success", async () => {
    const memberInfo: TrainerRoadMemberInfo = { MemberId: 42, Username: "testuser" };
    const fetchFn = mockFetch({ status: 200, ok: true, body: memberInfo });
    const client = new TrainerRoadClient("test-auth-cookie", fetchFn);

    const result = await client.getMemberInfo();

    expect(result).toEqual(memberInfo);
    const [url]: [string] = fetchFn.mock.calls[0];
    expect(url).toContain("/app/api/member-info");
  });
});
