import { describe, expect, it } from "vitest";
import { ZodError, type z } from "zod";
import {
  type FitbitActivity,
  FitbitClient,
  type FitbitDailySummary,
  type FitbitSleepLog,
  type FitbitWeightLog,
  fitbitActivitySchema,
  fitbitDailySummarySchema,
  fitbitSleepLogSchema,
  fitbitWeightLogSchema,
} from "./client.ts";

// ============================================================
// Sample API responses
// ============================================================

const sampleActivity: FitbitActivity = {
  logId: 12345678,
  activityName: "Run",
  activityTypeId: 90009,
  startTime: "08:30",
  activeDuration: 3600000, // 60 min in ms
  calories: 450,
  distance: 10.5,
  distanceUnit: "Kilometer",
  steps: 8500,
  averageHeartRate: 155,
  heartRateZones: [
    { name: "Out of Range", min: 30, max: 100, minutes: 2 },
    { name: "Fat Burn", min: 100, max: 140, minutes: 10 },
    { name: "Cardio", min: 140, max: 170, minutes: 35 },
    { name: "Peak", min: 170, max: 220, minutes: 13 },
  ],
  logType: "auto_detected",
  startDate: "2026-03-01",
  tcxLink: "https://api.fitbit.com/1/user/-/activities/12345678.tcx",
};

const sampleSleep: FitbitSleepLog = {
  logId: 87654321,
  dateOfSleep: "2026-03-01",
  startTime: "2026-02-28T23:15:00.000",
  endTime: "2026-03-01T07:00:00.000",
  duration: 27900000, // 7h 45m in ms
  efficiency: 92,
  isMainSleep: true,
  type: "stages",
  levels: {
    summary: {
      deep: { count: 4, minutes: 85, thirtyDayAvgMinutes: 80 },
      light: { count: 28, minutes: 210, thirtyDayAvgMinutes: 200 },
      rem: { count: 6, minutes: 95, thirtyDayAvgMinutes: 90 },
      wake: { count: 30, minutes: 35, thirtyDayAvgMinutes: 40 },
    },
  },
};

const sampleDailySummary: FitbitDailySummary = {
  summary: {
    steps: 12345,
    caloriesOut: 2800,
    activeScore: -1,
    activityCalories: 1200,
    restingHeartRate: 58,
    distances: [
      { activity: "total", distance: 9.5 },
      { activity: "tracker", distance: 9.5 },
    ],
    fairlyActiveMinutes: 25,
    veryActiveMinutes: 45,
    lightlyActiveMinutes: 180,
    sedentaryMinutes: 720,
    floors: 12,
  },
};

const sampleWeightLog: FitbitWeightLog = {
  logId: 55555,
  weight: 82.5,
  bmi: 24.8,
  fat: 18.5,
  date: "2026-03-01",
  time: "07:30:00",
};

function expectSchemaParseAndKeys<T extends Record<string, unknown>>(
  schema: z.ZodSchema<T>,
  input: T,
  requiredKeys: string[],
): void {
  const parsed: Record<string, unknown> = schema.parse(input);
  for (const key of requiredKeys) {
    expect(key in parsed).toBe(true);
    expect(parsed[key]).not.toBeUndefined();
  }
}

// ============================================================
// Tests
// ============================================================

describe("Fitbit API schemas", () => {
  it("accepts valid activity, sleep, daily summary, and weight objects", () => {
    expectSchemaParseAndKeys(fitbitActivitySchema, sampleActivity, [
      "logId",
      "activityName",
      "activityTypeId",
    ]);
    expectSchemaParseAndKeys(fitbitSleepLogSchema, sampleSleep, ["logId", "dateOfSleep", "type"]);
    expectSchemaParseAndKeys(fitbitDailySummarySchema, sampleDailySummary, ["summary"]);
    expectSchemaParseAndKeys(fitbitWeightLogSchema, sampleWeightLog, ["logId", "weight", "date"]);
  });

  it("rejects malformed data and invalid enum values", () => {
    expect(fitbitActivitySchema.safeParse({}).success).toBe(false);
    expect(
      fitbitActivitySchema.safeParse({
        ...sampleActivity,
        heartRateZones: [{ min: 120, max: 150, minutes: 20 }],
      }).success,
    ).toBe(false);
    expect(fitbitSleepLogSchema.safeParse({ ...sampleSleep, type: "nap" }).success).toBe(false);
    expect(
      fitbitDailySummarySchema.safeParse({
        summary: { ...sampleDailySummary.summary, distances: [{ distance: 5 }] },
      }).success,
    ).toBe(false);
    expect(fitbitWeightLogSchema.safeParse({ ...sampleWeightLog, weight: "82.5" }).success).toBe(
      false,
    );
  });
});

describe("FitbitClient schema validation", () => {
  it("rejects malformed list responses from activity/sleep/weight endpoints", async () => {
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
    ): Promise<Response> => {
      const url = input.toString();
      if (url.includes("/activities/list.json")) {
        return Response.json({ activities: [sampleActivity] });
      }
      if (url.includes("/sleep/list.json")) {
        return Response.json({ sleep: [sampleSleep] });
      }
      if (url.includes("/body/log/weight/date/")) {
        return Response.json({});
      }
      return new Response("Not found", { status: 404 });
    };

    const client = new FitbitClient("test-token", mockFetch);
    await expect(client.getActivities("2026-03-01", 0)).rejects.toThrow();
    await expect(client.getSleepLogs("2026-03-01", 0)).rejects.toThrow();
    await expect(client.getWeightLogs("2026-03-01")).rejects.toThrow();
  });
});

describe("FitbitClient — API calls", () => {
  it("getActivities sends correct URL with afterDate and offset", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = input.toString();
      return Response.json({
        activities: [],
        pagination: { next: "", previous: "", limit: 20, offset: 0, sort: "asc" },
      });
    };

    const client = new FitbitClient("test-token", mockFetch);
    await client.getActivities("2026-03-01", 10);

    expect(capturedUrl).toContain("/1/user/-/activities/list.json");
    expect(capturedUrl).toContain("afterDate=2026-03-01");
    expect(capturedUrl).toContain("offset=10");
    expect(capturedUrl).toContain("sort=asc");
    expect(capturedUrl).toContain("limit=20");
  });

  it("getSleepLogs sends correct URL", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = input.toString();
      return Response.json({
        sleep: [],
        pagination: { next: "", previous: "", limit: 20, offset: 0, sort: "asc" },
      });
    };

    const client = new FitbitClient("test-token", mockFetch);
    await client.getSleepLogs("2026-03-01", 5);

    expect(capturedUrl).toContain("/1.2/user/-/sleep/list.json");
    expect(capturedUrl).toContain("afterDate=2026-03-01");
    expect(capturedUrl).toContain("offset=5");
  });

  it("getDailySummary sends correct URL with date", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = input.toString();
      return Response.json({
        summary: {
          steps: 0,
          caloriesOut: 0,
          activeScore: 0,
          activityCalories: 0,
          distances: [],
          fairlyActiveMinutes: 0,
          veryActiveMinutes: 0,
          lightlyActiveMinutes: 0,
          sedentaryMinutes: 0,
        },
      });
    };

    const client = new FitbitClient("test-token", mockFetch);
    await client.getDailySummary("2026-03-15");

    expect(capturedUrl).toContain("/1/user/-/activities/date/2026-03-15.json");
  });

  it("getWeightLogs sends correct URL", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = input.toString();
      return Response.json({ weight: [] });
    };

    const client = new FitbitClient("test-token", mockFetch);
    await client.getWeightLogs("2026-03-01");

    expect(capturedUrl).toContain("/1/user/-/body/log/weight/date/2026-03-01/30d.json");
  });

  it("sends Authorization header with Bearer token", async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch: typeof globalThis.fetch = async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      capturedHeaders = Object.fromEntries(Object.entries(init?.headers ?? {}));
      return Response.json({
        activities: [],
        pagination: { next: "", previous: "", limit: 20, offset: 0, sort: "asc" },
      });
    };

    const client = new FitbitClient("my-secret-token", mockFetch);
    await client.getActivities("2026-03-01");

    expect(capturedHeaders.Authorization).toBe("Bearer my-secret-token");
  });

  it("throws on non-OK response", async () => {
    const mockFetch: typeof globalThis.fetch = async () => {
      return new Response("Unauthorized", { status: 401 });
    };

    const client = new FitbitClient("bad-token", mockFetch);
    await expect(client.getActivities("2026-03-01")).rejects.toThrow("API error 401");
  });

  it("includes response body in error message", async () => {
    const mockFetch: typeof globalThis.fetch = async () => {
      return new Response("Rate limit exceeded", { status: 429 });
    };

    const client = new FitbitClient("token", mockFetch);
    await expect(client.getWeightLogs("2026-03-01")).rejects.toThrow("Rate limit exceeded");
  });

  it("uses default offset of 0 for getActivities", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = input.toString();
      return Response.json({
        activities: [],
        pagination: { next: "", previous: "", limit: 20, offset: 0, sort: "asc" },
      });
    };

    const client = new FitbitClient("test-token", mockFetch);
    await client.getActivities("2026-03-01");

    expect(capturedUrl).toContain("offset=0");
  });
});

describe("FitbitClient — Zod runtime validation", () => {
  it("rejects an activity response with invalid shape", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({ activities: "not-an-array" });
    };

    const client = new FitbitClient("token", mockFetch);
    await expect(client.getActivities("2026-03-01")).rejects.toThrow(ZodError);
  });

  it("rejects a sleep response with missing pagination", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({ sleep: [] });
    };

    const client = new FitbitClient("token", mockFetch);
    await expect(client.getSleepLogs("2026-03-01")).rejects.toThrow(ZodError);
  });

  it("validates and returns a correct weight response", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({
        weight: [{ logId: 1, weight: 80.0, bmi: 24.0, date: "2026-03-01", time: "08:00:00" }],
      });
    };

    const client = new FitbitClient("token", mockFetch);
    const result = await client.getWeightLogs("2026-03-01");
    expect(result.weight).toHaveLength(1);
    expect(result.weight[0]?.weight).toBe(80.0);
  });
});
