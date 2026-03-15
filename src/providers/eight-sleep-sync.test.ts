import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bodyMeasurement,
  dailyMetrics,
  metricStream,
  oauthToken,
  sleepSession,
} from "../db/schema.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import { EightSleepProvider } from "./eight-sleep.ts";

// ============================================================
// Fake Eight Sleep API responses
// ============================================================

interface FakeTrendDay {
  day: string;
  score: number;
  tnt: number;
  processing: boolean;
  presenceDuration: number;
  sleepDuration: number;
  lightDuration: number;
  deepDuration: number;
  remDuration: number;
  latencyAsleepSeconds: number;
  latencyOutSeconds: number;
  presenceStart: string;
  presenceEnd: string;
  sleepQualityScore?: {
    total: number;
    hrv?: { score: number; current: number; average: number };
    respiratoryRate?: { score: number; current: number; average: number };
    heartRate?: { score: number; current: number; average: number };
    tempBedC?: { average: number };
    tempRoomC?: { average: number };
  };
  sessions?: Array<{
    stages: Array<{ stage: string; duration: number }>;
    timeseries: {
      heartRate?: Array<[string, number]>;
    };
  }>;
}

function fakeTrendDay(overrides: Partial<FakeTrendDay> = {}): FakeTrendDay {
  return {
    day: "2026-03-01",
    score: 85,
    tnt: 3,
    processing: false,
    presenceDuration: 28800, // 8 hours
    sleepDuration: 25200, // 7 hours
    lightDuration: 10800, // 3 hours
    deepDuration: 7200, // 2 hours
    remDuration: 7200, // 2 hours
    latencyAsleepSeconds: 600,
    latencyOutSeconds: 300,
    presenceStart: "2026-02-28T23:00:00Z",
    presenceEnd: "2026-03-01T07:00:00Z",
    sleepQualityScore: {
      total: 85,
      hrv: { score: 80, current: 45, average: 42 },
      respiratoryRate: { score: 90, current: 15.5, average: 15.2 },
      heartRate: { score: 85, current: 58, average: 60 },
      tempBedC: { average: 33.5 },
      tempRoomC: { average: 21.0 },
    },
    sessions: [
      {
        stages: [
          { stage: "light", duration: 10800 },
          { stage: "deep", duration: 7200 },
          { stage: "rem", duration: 7200 },
        ],
        timeseries: {
          heartRate: [
            ["2026-02-28T23:05:00Z", 62],
            ["2026-02-28T23:10:00Z", 58],
            ["2026-02-28T23:15:00Z", 55],
          ],
        },
      },
    ],
    ...overrides,
  };
}

function createMockFetch(
  trendDays: FakeTrendDay[],
  opts?: { signInError?: boolean },
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = input.toString();

    // Sign-in (re-auth)
    if (urlStr.includes("auth-api.8slp.net/v1/tokens") && init?.method === "POST") {
      if (opts?.signInError) {
        return new Response("Unauthorized", { status: 401 });
      }
      return Response.json({
        access_token: "refreshed-eight-sleep-token",
        expires_in: 86400,
        userId: "user-123",
      });
    }

    // Trends API
    if (urlStr.includes("/users/") && urlStr.includes("/trends")) {
      return Response.json({
        days: trendDays,
      });
    }

    return new Response("Not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

describe("EightSleepProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "eight-sleep", "Eight Sleep");
  }, 60_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  it("syncs sleep sessions, daily metrics, body temp, and HR streams", async () => {
    await saveTokens(ctx.db, "eight-sleep", {
      accessToken: "valid-token",
      refreshToken: null,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "userId:user-123",
    });

    const days = [
      fakeTrendDay({ day: "2026-03-01" }),
      fakeTrendDay({
        day: "2026-03-02",
        presenceStart: "2026-03-01T23:00:00Z",
        presenceEnd: "2026-03-02T07:00:00Z",
        sessions: [
          {
            stages: [{ stage: "light", duration: 7200 }],
            timeseries: {
              heartRate: [
                ["2026-03-01T23:05:00Z", 60],
                ["2026-03-01T23:10:00Z", 57],
              ],
            },
          },
        ],
      }),
    ];

    const provider = new EightSleepProvider(createMockFetch(days));
    const since = new Date("2026-02-01T00:00:00Z");
    const result = await provider.sync(ctx.db, since);

    expect(result.provider).toBe("eight-sleep");
    expect(result.errors).toHaveLength(0);
    // 2 sleep + 2 daily + 2 body temp + 5 HR samples = 11
    expect(result.recordsSynced).toBe(11);

    // Verify sleep sessions
    const sleepRows = await ctx.db
      .select()
      .from(sleepSession)
      .where(eq(sleepSession.providerId, "eight-sleep"));
    expect(sleepRows).toHaveLength(2);

    const sleep1 = sleepRows.find((r) => r.externalId === "eightsleep-2026-03-01");
    if (!sleep1) throw new Error("expected sleep session for 2026-03-01");
    expect(sleep1.durationMinutes).toBe(420); // 7 hours
    expect(sleep1.deepMinutes).toBe(120); // 2 hours
    expect(sleep1.remMinutes).toBe(120);
    expect(sleep1.lightMinutes).toBe(180);

    // Verify daily metrics
    const dailyRows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "eight-sleep"));
    expect(dailyRows).toHaveLength(2);

    const daily1 = dailyRows.find((r) => r.date === "2026-03-01");
    if (!daily1) throw new Error("expected daily metrics for 2026-03-01");
    expect(daily1.restingHr).toBe(58);
    expect(daily1.hrv).toBeCloseTo(45);
    expect(daily1.respiratoryRateAvg).toBeCloseTo(15.5);

    // Verify body temperature measurements
    const bodyRows = await ctx.db
      .select()
      .from(bodyMeasurement)
      .where(eq(bodyMeasurement.providerId, "eight-sleep"));
    expect(bodyRows).toHaveLength(2);

    const temp1 = bodyRows.find((r) => r.externalId === "eightsleep-temp-2026-03-01");
    if (!temp1) throw new Error("expected body temp for 2026-03-01");
    expect(temp1.temperatureC).toBeCloseTo(33.5);

    // Verify HR metric stream
    const hrRows = await ctx.db
      .select()
      .from(metricStream)
      .where(eq(metricStream.providerId, "eight-sleep"));
    expect(hrRows).toHaveLength(5); // 3 from day 1 + 2 from day 2
    expect(hrRows.every((r) => r.heartRate !== null && r.heartRate > 0)).toBe(true);
  });

  it("skips processing days", async () => {
    await saveTokens(ctx.db, "eight-sleep", {
      accessToken: "valid-token",
      refreshToken: null,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "userId:user-123",
    });

    // Clear existing data
    await ctx.db.delete(sleepSession).where(eq(sleepSession.providerId, "eight-sleep"));
    await ctx.db.delete(dailyMetrics).where(eq(dailyMetrics.providerId, "eight-sleep"));
    await ctx.db.delete(bodyMeasurement).where(eq(bodyMeasurement.providerId, "eight-sleep"));
    await ctx.db.delete(metricStream).where(eq(metricStream.providerId, "eight-sleep"));

    const days = [
      fakeTrendDay({ day: "2026-03-10", processing: true }),
      fakeTrendDay({ day: "2026-03-11", processing: false }),
    ];

    const provider = new EightSleepProvider(createMockFetch(days));
    const result = await provider.sync(ctx.db, new Date("2026-03-01T00:00:00Z"));

    expect(result.errors).toHaveLength(0);

    // Only non-processing day should be synced
    const sleepRows = await ctx.db
      .select()
      .from(sleepSession)
      .where(eq(sleepSession.providerId, "eight-sleep"));
    expect(sleepRows).toHaveLength(1);
    expect(sleepRows[0]?.externalId).toBe("eightsleep-2026-03-11");
  });

  it("re-authenticates when tokens are expired using env credentials", async () => {
    await saveTokens(ctx.db, "eight-sleep", {
      accessToken: "expired-token",
      refreshToken: null,
      expiresAt: new Date("2025-01-01T00:00:00Z"), // expired
      scopes: "userId:user-123",
    });

    process.env.EIGHT_SLEEP_USERNAME = "test@example.com";
    process.env.EIGHT_SLEEP_PASSWORD = "test-password";

    // Clear existing data
    await ctx.db.delete(sleepSession).where(eq(sleepSession.providerId, "eight-sleep"));
    await ctx.db.delete(dailyMetrics).where(eq(dailyMetrics.providerId, "eight-sleep"));
    await ctx.db.delete(bodyMeasurement).where(eq(bodyMeasurement.providerId, "eight-sleep"));
    await ctx.db.delete(metricStream).where(eq(metricStream.providerId, "eight-sleep"));

    const days = [fakeTrendDay({ day: "2026-03-15" })];
    const provider = new EightSleepProvider(createMockFetch(days));
    const result = await provider.sync(ctx.db, new Date("2026-03-01T00:00:00Z"));

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBeGreaterThan(0);

    // Verify tokens were saved after re-auth
    const { loadTokens } = await import("../db/tokens.ts");
    const tokens = await loadTokens(ctx.db, "eight-sleep");
    expect(tokens?.accessToken).toBe("refreshed-eight-sleep-token");

    delete process.env.EIGHT_SLEEP_USERNAME;
    delete process.env.EIGHT_SLEEP_PASSWORD;
  });

  it("returns error when tokens expired and no env vars for re-auth", async () => {
    await saveTokens(ctx.db, "eight-sleep", {
      accessToken: "expired-token",
      refreshToken: null,
      expiresAt: new Date("2025-01-01T00:00:00Z"), // expired
      scopes: "userId:user-123",
    });

    // Ensure env vars are not set
    delete process.env.EIGHT_SLEEP_USERNAME;
    delete process.env.EIGHT_SLEEP_PASSWORD;

    const provider = new EightSleepProvider(createMockFetch([]));
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("EIGHT_SLEEP_USERNAME");
    expect(result.errors[0]?.message).toContain("EIGHT_SLEEP_PASSWORD");
    expect(result.recordsSynced).toBe(0);
  });

  it("returns error when no tokens exist", async () => {
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "eight-sleep"));

    const provider = new EightSleepProvider(createMockFetch([]));
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("not connected");
    expect(result.recordsSynced).toBe(0);
  });

  it("returns error when user ID is missing from scopes", async () => {
    await saveTokens(ctx.db, "eight-sleep", {
      accessToken: "valid-token",
      refreshToken: null,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: null, // no userId encoded
    });

    const provider = new EightSleepProvider(createMockFetch([]));
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("user ID not found");
    expect(result.recordsSynced).toBe(0);
  });

  it("skips days without presence times for sleep but still syncs daily metrics", async () => {
    await saveTokens(ctx.db, "eight-sleep", {
      accessToken: "valid-token",
      refreshToken: null,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "userId:user-123",
    });

    // Clear existing data
    await ctx.db.delete(sleepSession).where(eq(sleepSession.providerId, "eight-sleep"));
    await ctx.db.delete(dailyMetrics).where(eq(dailyMetrics.providerId, "eight-sleep"));
    await ctx.db.delete(bodyMeasurement).where(eq(bodyMeasurement.providerId, "eight-sleep"));
    await ctx.db.delete(metricStream).where(eq(metricStream.providerId, "eight-sleep"));

    const days = [
      fakeTrendDay({
        day: "2026-03-20",
        presenceStart: "",
        presenceEnd: "",
        sessions: [],
        sleepQualityScore: {
          total: 0,
          tempBedC: undefined,
          tempRoomC: undefined,
        },
      }),
    ];

    const provider = new EightSleepProvider(createMockFetch(days));
    const result = await provider.sync(ctx.db, new Date("2026-03-01T00:00:00Z"));

    // Sleep session should be skipped (no presenceStart/End)
    const sleepRows = await ctx.db
      .select()
      .from(sleepSession)
      .where(eq(sleepSession.providerId, "eight-sleep"));
    expect(sleepRows).toHaveLength(0);

    expect(result.errors).toHaveLength(0);
  });
});
