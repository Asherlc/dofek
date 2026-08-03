import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dailyMetrics, sleepSession } from "../db/schema/activity.ts";
import { oauthToken, userProfile } from "../db/schema/reference.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import { EightSleepProvider } from "./eight-sleep.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { createCapturingMetricStreamPublisher } from "./test-helpers.ts";

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
const metricStreamCapture = createCapturingMetricStreamPublisher();

async function clearEightSleepRows(ctx: TestContext) {
  await ctx.db.delete(sleepSession).where(eq(sleepSession.providerId, "eight-sleep"));
  await ctx.db.delete(dailyMetrics).where(eq(dailyMetrics.providerId, "eight-sleep"));
}

async function saveValidEightSleepTokens(ctx: TestContext) {
  await saveTokens(ctx.db, "eight-sleep", {
    accessToken: "valid-token",
    refreshToken: null,
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    scopes: "userId:user-123",
  });
}

describe("EightSleepProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
    server.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
    await ensureProvider(ctx.db, "eight-sleep", "Eight Sleep");
  }, 60_000);

  beforeEach(() => {
    metricStreamCapture.publishedMetricStreamRows.length = 0;
  });

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
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: since }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

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
    expect(sleep1.stagingAvailable).toBe(true);

    // Verify daily metrics
    const dailyRows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "eight-sleep"));
    expect(dailyRows).toHaveLength(2);

    const daily1 = dailyRows.find((r) => r.date === "2026-03-01");
    if (!daily1) throw new Error("expected daily metrics for 2026-03-01");
    expect(daily1.hrv).toBeCloseTo(45);
    expect(daily1.respiratoryRateAvg).toBeCloseTo(15.5);

    const streamRows = metricStreamCapture.publishedMetricStreamRows;
    const bodyTemperatureRows = streamRows.filter((row) => row.channel === "body_temperature");
    expect(bodyTemperatureRows).toHaveLength(2);

    const temp1 = bodyTemperatureRows.find((r) => r.externalId === "eightsleep-temp-2026-03-01");
    if (!temp1) throw new Error("expected body temp for 2026-03-01");
    expect(temp1.scalar).toBeCloseTo(33.5);

    // Verify HR metric stream
    const heartRateRows = streamRows.filter((row) => row.channel === "heart_rate");
    expect(heartRateRows).toHaveLength(5); // 3 from day 1 + 2 from day 2
    expect(heartRateRows.every((row) => row.scalar != null && row.scalar > 0)).toBe(true);
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

    const days = [
      fakeTrendDay({ day: "2026-03-10", processing: true }),
      fakeTrendDay({ day: "2026-03-11", processing: false }),
    ];

    server.use(...eightSleepHandlers(days));

    const provider = new EightSleepProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-03-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

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
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("Eight Sleep access token expired.");
    expect(result.errors[0]?.cause).toMatchObject({ authFailureReason: "access_token_expired" });
    expect(result.recordsSynced).toBe(0);
  });

  it("returns error when no tokens exist", async () => {
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "eight-sleep"));

    const provider = new EightSleepProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

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
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("user ID not found");
    expect(result.errors[0]?.cause).toMatchObject({ authFailureReason: "authentication_failed" });
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
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-03-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    // Sleep session should be skipped (no presenceStart/End)
    const sleepRows = await ctx.db
      .select()
      .from(sleepSession)
      .where(eq(sleepSession.providerId, "eight-sleep"));
    expect(sleepRows).toHaveLength(0);

    expect(result.errors).toHaveLength(0);
  });

  it("skips sleep when either presence boundary is missing", async () => {
    await saveValidEightSleepTokens(ctx);
    await clearEightSleepRows(ctx);

    server.use(
      ...eightSleepHandlers([
        fakeTrendDay({
          day: "2026-03-21",
          presenceStart: "",
          presenceEnd: "2026-03-21T07:00:00Z",
          sessions: [],
        }),
      ]),
    );

    const provider = new EightSleepProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-03-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(0);
    const sleepRows = await ctx.db
      .select()
      .from(sleepSession)
      .where(eq(sleepSession.providerId, "eight-sleep"));
    expect(sleepRows).toHaveLength(0);
  });

  it("syncs daily metrics when any supported quality metric is present", async () => {
    await saveValidEightSleepTokens(ctx);
    await clearEightSleepRows(ctx);

    server.use(
      ...eightSleepHandlers([
        fakeTrendDay({
          day: "2026-03-22",
          presenceStart: "",
          presenceEnd: "",
          sessions: [],
          sleepQualityScore: {
            total: 0,
            hrv: { score: 80, current: 44, average: 40 },
          },
        }),
        fakeTrendDay({
          day: "2026-03-23",
          presenceStart: "",
          presenceEnd: "",
          sessions: [],
          sleepQualityScore: {
            total: 0,
            respiratoryRate: { score: 90, current: 15.4, average: 15.1 },
          },
        }),
        fakeTrendDay({
          day: "2026-03-24",
          presenceStart: "",
          presenceEnd: "",
          sessions: [],
          sleepQualityScore: {
            total: 0,
            tempBedC: { average: 33.2 },
          },
        }),
      ]),
    );

    const provider = new EightSleepProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-03-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(0);
    const dailyRows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "eight-sleep"));
    expect(dailyRows).toHaveLength(3);
    expect(dailyRows.map((row) => row.date).sort()).toEqual([
      "2026-03-22",
      "2026-03-23",
      "2026-03-24",
    ]);
  });

  it("skips daily metrics when every supported quality metric is absent", async () => {
    await saveValidEightSleepTokens(ctx);
    await clearEightSleepRows(ctx);

    server.use(
      ...eightSleepHandlers([
        fakeTrendDay({
          day: "2026-03-25",
          presenceStart: "",
          presenceEnd: "",
          sessions: [],
          sleepQualityScore: { total: 0 },
        }),
      ]),
    );

    const provider = new EightSleepProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-03-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(0);
    const dailyRows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "eight-sleep"));
    expect(dailyRows).toHaveLength(0);
  });

  it("syncs bed temperature without room temperature and falls back to the day timestamp", async () => {
    await saveValidEightSleepTokens(ctx);
    await clearEightSleepRows(ctx);

    server.use(
      ...eightSleepHandlers([
        fakeTrendDay({
          day: "2026-03-26",
          presenceStart: "",
          presenceEnd: "",
          sessions: [],
          sleepQualityScore: {
            total: 0,
            tempBedC: { average: 33.4 },
          },
        }),
      ]),
    );

    const provider = new EightSleepProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-03-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(0);
    const temperatureRows = metricStreamCapture.publishedMetricStreamRows;
    expect(temperatureRows).toHaveLength(1);
    const temperatureRow = temperatureRows[0];
    if (!temperatureRow) throw new Error("expected temperature row");
    expect(temperatureRow.channel).toBe("body_temperature");
    expect(temperatureRow.scalar).toBeCloseTo(33.4);
    expect(new Date(temperatureRow.recordedAt).toISOString()).toBe("2026-03-26T00:00:00.000Z");
  });

  it("skips temperature and heart-rate streams when optional source fields are absent", async () => {
    await saveValidEightSleepTokens(ctx);
    await clearEightSleepRows(ctx);

    server.use(
      ...eightSleepHandlers([
        fakeTrendDay({
          day: "2026-03-27",
          sessions: undefined,
          sleepQualityScore: undefined,
        }),
      ]),
    );

    const provider = new EightSleepProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-03-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(0);
    const streamRows = metricStreamCapture.publishedMetricStreamRows;
    expect(streamRows).toHaveLength(0);
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
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-03-20T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

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

    const publishedTemperatureRows = metricStreamCapture.publishedMetricStreamRows.filter(
      (row) => row.externalId === temperatureExternalId,
    );
    expect(publishedTemperatureRows.filter((row) => row.userId === currentUserId)).toHaveLength(1);
  });
});
