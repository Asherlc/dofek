import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  bodyMeasurement,
  dailyMetrics,
  oauthToken,
  sensorSample,
  sleepSession,
  userProfile,
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

function eightSleepHandlers(trendDays: FakeTrendDay[]) {
  return [
    // Trends API
    http.get("https://client-api.8slp.net/v1/users/:userId/trends", () => {
      return HttpResponse.json({
        days: trendDays,
      });
    }),
  ];
}

const server = setupServer();

describe("EightSleepProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
    server.listen({ onUnhandledRequest: "error" });
    await ensureProvider(ctx.db, "eight-sleep", "Eight Sleep");
  }, 60_000);

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
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

    server.use(...eightSleepHandlers(days));

    const provider = new EightSleepProvider();
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
      .from(sensorSample)
      .where(eq(sensorSample.providerId, "eight-sleep"));
    expect(hrRows).toHaveLength(5); // 3 from day 1 + 2 from day 2
    expect(hrRows.every((r) => r.scalar !== null && r.scalar > 0)).toBe(true);
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
    await ctx.db.delete(sensorSample).where(eq(sensorSample.providerId, "eight-sleep"));

    const days = [
      fakeTrendDay({ day: "2026-03-10", processing: true }),
      fakeTrendDay({ day: "2026-03-11", processing: false }),
    ];

    server.use(...eightSleepHandlers(days));

    const provider = new EightSleepProvider();
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

  it("returns error when tokens are expired", async () => {
    await saveTokens(ctx.db, "eight-sleep", {
      accessToken: "expired-token",
      refreshToken: null,
      expiresAt: new Date("2025-01-01T00:00:00Z"), // expired
      scopes: "userId:user-123",
    });

    const provider = new EightSleepProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain(
      "Eight Sleep token expired — please re-authenticate via Settings",
    );
    expect(result.recordsSynced).toBe(0);
  });

  it("returns error when no tokens exist", async () => {
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "eight-sleep"));

    const provider = new EightSleepProvider();
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

    const provider = new EightSleepProvider();
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
    await ctx.db.delete(sensorSample).where(eq(sensorSample.providerId, "eight-sleep"));

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

    server.use(...eightSleepHandlers(days));

    const provider = new EightSleepProvider();
    const result = await provider.sync(ctx.db, new Date("2026-03-01T00:00:00Z"));

    // Sleep session should be skipped (no presenceStart/End)
    const sleepRows = await ctx.db
      .select()
      .from(sleepSession)
      .where(eq(sleepSession.providerId, "eight-sleep"));
    expect(sleepRows).toHaveLength(0);

    expect(result.errors).toHaveLength(0);
  });

  it("does not overwrite another user's rows with matching external identifiers", async () => {
    await saveTokens(ctx.db, "eight-sleep", {
      accessToken: "valid-token",
      refreshToken: null,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "userId:user-123",
    });

    const currentUserId = process.env.TEST_TOKEN_USER_ID;
    if (!currentUserId) {
      throw new Error("TEST_TOKEN_USER_ID is required for this integration test");
    }

    const secondUserId = "44444444-4444-4444-4444-444444444444";
    await ctx.db
      .insert(userProfile)
      .values({ id: secondUserId, name: "Eight Sleep Other User" })
      .onConflictDoNothing();

    const day = "2026-03-29";
    const sleepExternalId = `eightsleep-${day}`;
    const temperatureExternalId = `eightsleep-temp-${day}`;

    await ctx.db.insert(sleepSession).values({
      userId: secondUserId,
      providerId: "eight-sleep",
      externalId: sleepExternalId,
      startedAt: new Date("2026-03-28T23:00:00Z"),
      endedAt: new Date("2026-03-29T07:00:00Z"),
      durationMinutes: 300,
    });
    await ctx.db.insert(dailyMetrics).values({
      userId: secondUserId,
      providerId: "eight-sleep",
      date: day,
      steps: 1234,
    });
    await ctx.db.insert(bodyMeasurement).values({
      userId: secondUserId,
      providerId: "eight-sleep",
      externalId: temperatureExternalId,
      recordedAt: new Date("2026-03-28T23:00:00Z"),
      temperatureC: 31.2,
    });

    server.use(
      ...eightSleepHandlers([
        fakeTrendDay({
          day,
          presenceStart: "2026-03-28T23:00:00Z",
          presenceEnd: "2026-03-29T07:00:00Z",
        }),
      ]),
    );

    const provider = new EightSleepProvider();
    const result = await provider.sync(ctx.db, new Date("2026-03-20T00:00:00Z"));

    expect(result.errors).toHaveLength(0);

    const sleepRows = await ctx.db
      .select()
      .from(sleepSession)
      .where(eq(sleepSession.externalId, sleepExternalId));
    expect(sleepRows.filter((row) => row.userId === secondUserId)).toHaveLength(1);
    expect(sleepRows.filter((row) => row.userId === currentUserId)).toHaveLength(1);

    const dailyRows = await ctx.db.select().from(dailyMetrics).where(eq(dailyMetrics.date, day));
    const providerDailyRows = dailyRows.filter((row) => row.providerId === "eight-sleep");
    expect(providerDailyRows.filter((row) => row.userId === secondUserId)).toHaveLength(1);
    expect(providerDailyRows.filter((row) => row.userId === currentUserId)).toHaveLength(1);

    const temperatureRows = await ctx.db
      .select()
      .from(bodyMeasurement)
      .where(eq(bodyMeasurement.externalId, temperatureExternalId));
    expect(temperatureRows.filter((row) => row.userId === secondUserId)).toHaveLength(1);
    expect(temperatureRows.filter((row) => row.userId === currentUserId)).toHaveLength(1);
  });
});
