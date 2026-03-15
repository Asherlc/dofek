import { describe, expect, it, vi, beforeEach } from "vitest";
import { TrainingPeaksConnectClient } from "../client.ts";

type MockFetchFn = ReturnType<typeof vi.fn>;

function mockFetch(
  response: { status: number; ok: boolean; body: unknown },
): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    json: () => Promise.resolve(response.body),
    text: () =>
      Promise.resolve(
        typeof response.body === "string"
          ? response.body
          : JSON.stringify(response.body),
      ),
  });
}

// ============================================================
// Static auth methods
// ============================================================

describe("TrainingPeaksConnectClient.exchangeCookieForToken", () => {
  it("returns accessToken and expiresIn on success", async () => {
    const fetchFn = mockFetch({
      status: 200,
      ok: true,
      body: {
        success: true,
        token: {
          access_token: "tp-access-token",
          expires_in: 3600,
        },
      },
    });

    const result = await TrainingPeaksConnectClient.exchangeCookieForToken("my-cookie", fetchFn);

    expect(result.accessToken).toBe("tp-access-token");
    expect(result.expiresIn).toBe(3600);

    const [url, options] = (fetchFn as MockFetchFn).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/users/v3/token");
    const headers = options.headers as Record<string, string>;
    expect(headers.Cookie).toBe("Production_tpAuth=my-cookie");
  });

  it("throws on non-200 response", async () => {
    const fetchFn = mockFetch({ status: 401, ok: false, body: "Unauthorized" });

    await expect(
      TrainingPeaksConnectClient.exchangeCookieForToken("bad-cookie", fetchFn),
    ).rejects.toThrow("TrainingPeaks token exchange failed (401)");
  });

  it("throws when success is false", async () => {
    const fetchFn = mockFetch({
      status: 200,
      ok: true,
      body: {
        success: false,
        token: { access_token: "", expires_in: 0 },
      },
    });

    await expect(
      TrainingPeaksConnectClient.exchangeCookieForToken("expired-cookie", fetchFn),
    ).rejects.toThrow("success=false");
  });
});

describe("TrainingPeaksConnectClient.refreshCookie", () => {
  it("returns new cookie from getSetCookie", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 302,
      headers: {
        getSetCookie: () => [
          "Production_tpAuth=new-cookie-value; Path=/; HttpOnly",
          "other_cookie=value; Path=/",
        ],
        get: () => null,
      },
    }) as typeof globalThis.fetch;

    const result = await TrainingPeaksConnectClient.refreshCookie("old-cookie", fetchFn);

    expect(result).toBe("new-cookie-value");
    const [url, options] = (fetchFn as MockFetchFn).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/refresh");
    expect(options.redirect).toBe("manual");
  });

  it("falls back to set-cookie header splitting when getSetCookie is not available", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 302,
      headers: {
        getSetCookie: undefined,
        get: (name: string) => {
          if (name === "set-cookie") {
            return "other=val; Path=/, Production_tpAuth=fallback-cookie; Path=/; HttpOnly";
          }
          return null;
        },
      },
    }) as typeof globalThis.fetch;

    const result = await TrainingPeaksConnectClient.refreshCookie("old-cookie", fetchFn);

    expect(result).toBe("fallback-cookie");
  });

  it("throws when no Production_tpAuth cookie is returned", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 302,
      headers: {
        getSetCookie: () => ["some_other_cookie=value; Path=/"],
        get: () => null,
      },
    }) as typeof globalThis.fetch;

    await expect(
      TrainingPeaksConnectClient.refreshCookie("old-cookie", fetchFn),
    ).rejects.toThrow("did not return a new Production_tpAuth cookie");
  });

  it("throws when no set-cookie headers at all", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 302,
      headers: {
        getSetCookie: () => [],
        get: () => null,
      },
    }) as typeof globalThis.fetch;

    await expect(
      TrainingPeaksConnectClient.refreshCookie("old-cookie", fetchFn),
    ).rejects.toThrow("did not return a new Production_tpAuth cookie");
  });
});

// ============================================================
// Instance methods
// ============================================================

describe("TrainingPeaksConnectClient.getUser", () => {
  it("returns user profile", async () => {
    const user = {
      user: {
        personId: 123,
        firstName: "John",
        lastName: "Doe",
        email: "john@example.com",
        athletes: [{ athleteId: 456 }],
        settings: { account: { isPremium: true } },
      },
    };

    const fetchFn = mockFetch({ status: 200, ok: true, body: user });
    const client = new TrainingPeaksConnectClient("test-token", fetchFn);

    const result = await client.getUser();

    expect(result).toEqual(user);
    const [url, options] = (fetchFn as MockFetchFn).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/users/v3/user");
    const headers = options.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
  });
});

describe("TrainingPeaksConnectClient.getWorkouts", () => {
  it("returns workouts for date range", async () => {
    const workouts = [
      { workoutId: 1, athleteId: 456, workoutDay: "2024-01-15", title: "Morning Ride", completed: true, workoutTypeFamilyId: 2, workoutTypeValueId: 1 },
    ];

    const fetchFn = mockFetch({ status: 200, ok: true, body: workouts });
    const client = new TrainingPeaksConnectClient("test-token", fetchFn);

    const result = await client.getWorkouts(456, "2024-01-01", "2024-01-31");

    expect(result).toEqual(workouts);
    const [url] = (fetchFn as MockFetchFn).mock.calls[0] as [string];
    expect(url).toContain("/fitness/v6/athletes/456/workouts/2024-01-01/2024-01-31");
  });

  it("throws on non-200 response", async () => {
    const fetchFn = mockFetch({ status: 500, ok: false, body: "Server Error" });
    const client = new TrainingPeaksConnectClient("test-token", fetchFn);

    await expect(
      client.getWorkouts(456, "2024-01-01", "2024-01-31"),
    ).rejects.toThrow("TrainingPeaks API error (500)");
  });
});

describe("TrainingPeaksConnectClient.getWorkout", () => {
  it("returns a single workout", async () => {
    const workout = { workoutId: 789, athleteId: 456, workoutDay: "2024-01-15", title: "Tempo Run", completed: true, workoutTypeFamilyId: 1, workoutTypeValueId: 1 };

    const fetchFn = mockFetch({ status: 200, ok: true, body: workout });
    const client = new TrainingPeaksConnectClient("test-token", fetchFn);

    const result = await client.getWorkout(456, 789);

    expect(result).toEqual(workout);
    const [url] = (fetchFn as MockFetchFn).mock.calls[0] as [string];
    expect(url).toContain("/fitness/v6/athletes/456/workouts/789");
  });
});

describe("TrainingPeaksConnectClient.getWorkoutFitUrl", () => {
  it("returns FIT file URL", () => {
    const client = new TrainingPeaksConnectClient("test-token");
    const url = client.getWorkoutFitUrl(456, 789);

    expect(url).toContain("/fitness/v6/athletes/456/workouts/789/fordevice/fit");
  });
});

describe("TrainingPeaksConnectClient.getPerformanceManagement", () => {
  it("returns PMC data with default options", async () => {
    const pmcData = [
      { workoutDay: "2024-01-15", tssActual: 75, ctl: 60, atl: 80, tsb: -20 },
    ];

    const fetchFn = mockFetch({ status: 200, ok: true, body: pmcData });
    const client = new TrainingPeaksConnectClient("test-token", fetchFn);

    const result = await client.getPerformanceManagement(456, "2024-01-01", "2024-01-31");

    expect(result).toEqual(pmcData);
    const [url, options] = (fetchFn as MockFetchFn).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/fitness/v1/athletes/456/reporting/performancedata/2024-01-01/2024-01-31");
    expect(options.method).toBe("POST");

    const body = JSON.parse(options.body as string);
    expect(body.atlConstant).toBe(7);
    expect(body.ctlConstant).toBe(42);
    expect(body.atlStart).toBe(0);
    expect(body.ctlStart).toBe(0);
    expect(body.workoutTypes).toEqual([]);
  });

  it("uses custom options when provided", async () => {
    const fetchFn = mockFetch({ status: 200, ok: true, body: [] });
    const client = new TrainingPeaksConnectClient("test-token", fetchFn);

    await client.getPerformanceManagement(456, "2024-01-01", "2024-01-31", {
      atlConstant: 14,
      ctlConstant: 56,
      atlStart: 10,
      ctlStart: 20,
      workoutTypes: [2, 3],
    });

    const [, options] = (fetchFn as MockFetchFn).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.atlConstant).toBe(14);
    expect(body.ctlConstant).toBe(56);
    expect(body.atlStart).toBe(10);
    expect(body.ctlStart).toBe(20);
    expect(body.workoutTypes).toEqual([2, 3]);
  });

  it("throws on POST failure", async () => {
    const fetchFn = mockFetch({ status: 403, ok: false, body: "Forbidden" });
    const client = new TrainingPeaksConnectClient("test-token", fetchFn);

    await expect(
      client.getPerformanceManagement(456, "2024-01-01", "2024-01-31"),
    ).rejects.toThrow("TrainingPeaks API error (403)");
  });
});

describe("TrainingPeaksConnectClient.getPersonalRecords", () => {
  it("returns personal records without date filter", async () => {
    const records = [
      { workoutId: 1, workoutDay: "2024-01-15", title: "Best 20min", value: 280, rank: 1 },
    ];

    const fetchFn = mockFetch({ status: 200, ok: true, body: records });
    const client = new TrainingPeaksConnectClient("test-token", fetchFn);

    const result = await client.getPersonalRecords(456, "Bike", "power20min");

    expect(result).toEqual(records);
    const [url] = (fetchFn as MockFetchFn).mock.calls[0] as [string];
    expect(url).toContain("/personalrecord/v2/athletes/456/Bike");
    expect(url).toContain("prType=power20min");
    expect(url).not.toContain("startDate");
    expect(url).not.toContain("endDate");
  });

  it("includes date filters when provided", async () => {
    const fetchFn = mockFetch({ status: 200, ok: true, body: [] });
    const client = new TrainingPeaksConnectClient("test-token", fetchFn);

    await client.getPersonalRecords(456, "Run", "speed5K", "2024-01-01", "2024-12-31");

    const [url] = (fetchFn as MockFetchFn).mock.calls[0] as [string];
    expect(url).toContain("startDate=2024-01-01");
    expect(url).toContain("endDate=2024-12-31");
  });
});

describe("TrainingPeaksConnectClient.getCalendarNotes", () => {
  it("returns calendar notes", async () => {
    const notes = [
      { id: 1, athleteId: 456, date: "2024-01-15", title: "Rest day" },
    ];

    const fetchFn = mockFetch({ status: 200, ok: true, body: notes });
    const client = new TrainingPeaksConnectClient("test-token", fetchFn);

    const result = await client.getCalendarNotes(456, "2024-01-01", "2024-01-31");

    expect(result).toEqual(notes);
    const [url] = (fetchFn as MockFetchFn).mock.calls[0] as [string];
    expect(url).toContain("/fitness/v1/athletes/456/calendarNote/2024-01-01/2024-01-31");
  });
});

describe("TrainingPeaksConnectClient.getWorkoutAnalysis", () => {
  it("returns workout analysis data", async () => {
    const analysis = {
      totals: {
        duration: 3600,
        distance: 42000,
        calories: 900,
        tss: 75,
      },
      channels: [],
      laps: [],
    };

    const fetchFn = mockFetch({ status: 200, ok: true, body: analysis });
    const client = new TrainingPeaksConnectClient("test-token", fetchFn);

    const result = await client.getWorkoutAnalysis(789, 456);

    expect(result).toEqual(analysis);
    const [url, options] = (fetchFn as MockFetchFn).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("api.peakswaresb.com");
    expect(url).toContain("/workout-analysis/v1/analyze");
    expect(options.method).toBe("POST");

    const body = JSON.parse(options.body as string);
    expect(body.workoutId).toBe(789);
    expect(body.viewingPersonId).toBe(456);
  });
});

describe("TrainingPeaksConnectClient throttle", () => {
  it("applies throttle delay between rapid requests", async () => {
    const fetchFn = mockFetch({ status: 200, ok: true, body: {} });
    const client = new TrainingPeaksConnectClient("test-token", fetchFn);

    const start = Date.now();
    await client.getUser();
    await client.getUser();
    const elapsed = Date.now() - start;

    // Second request should be throttled by at least ~150ms
    // Use a lower bound to account for timing variance
    expect(elapsed).toBeGreaterThanOrEqual(100);
  });
});

describe("TrainingPeaksConnectClient request headers", () => {
  it("sends correct headers for GET requests", async () => {
    const fetchFn = mockFetch({ status: 200, ok: true, body: {} });
    const client = new TrainingPeaksConnectClient("test-token", fetchFn);

    await client.getUser();

    const [, options] = (fetchFn as MockFetchFn).mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers.Accept).toBe("application/json");
    expect(headers.Origin).toContain("trainingpeaks.com");
  });

  it("sends correct headers for POST requests", async () => {
    const fetchFn = mockFetch({ status: 200, ok: true, body: [] });
    const client = new TrainingPeaksConnectClient("test-token", fetchFn);

    await client.getPerformanceManagement(456, "2024-01-01", "2024-01-31");

    const [, options] = (fetchFn as MockFetchFn).mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer test-token");
  });
});
