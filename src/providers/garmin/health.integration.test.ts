import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dailyMetrics, sleepSession, sleepStage } from "../../db/schema/activity.ts";
import { TEST_USER_ID } from "../../db/schema/core.ts";
import { userProfile } from "../../db/schema/reference.ts";
import { setupTestDatabase, type TestContext } from "../../db/test-helpers.ts";
import { ensureProvider } from "../../db/tokens.ts";
import { createCapturingMetricStreamPublisher } from "../test-helpers.ts";
import { syncGarminHealthRecord } from "./health.ts";

const base = {
  userId: "garmin-owner",
  summaryId: "health-summary",
  calendarDate: "2026-10-20",
  startTimeInSeconds: 1792454400,
  startTimeOffsetInSeconds: -25200,
  durationInSeconds: 86400,
};

describe("official Garmin health persistence", () => {
  let context: TestContext;
  let capture: ReturnType<typeof createCapturingMetricStreamPublisher>;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await ensureProvider(context.db, "garmin", "Garmin", undefined, TEST_USER_ID);
  }, 60_000);

  afterAll(async () => context?.cleanup());

  beforeEach(async () => {
    await context.db.delete(sleepSession);
    await context.db.delete(dailyMetrics);
    capture = createCapturingMetricStreamPublisher();
  });

  function options(userId = TEST_USER_ID) {
    return { userId, metricStreamPublisher: capture.publisher };
  }

  it("upserts HRV before daily arrival and preserves unrelated fields across sparse corrections", async () => {
    await syncGarminHealthRecord(
      context.db,
      "hrv",
      { ...base, summaryId: "nightly-hrv", lastNightAvg: 44 },
      options(),
    );
    const [initial] = await context.db.select().from(dailyMetrics);
    expect(initial).toMatchObject({ date: base.calendarDate, hrv: 44, steps: null });

    await syncGarminHealthRecord(
      context.db,
      "dailies",
      {
        ...base,
        steps: 3000,
        distanceInMeters: 2000,
        floorsClimbed: 5,
        activeTimeInSeconds: 1800,
        moderateIntensityDurationInSeconds: 1800,
        vigorousIntensityDurationInSeconds: 2400,
        activeKilocalories: 400,
        bmrKilocalories: 1800,
      },
      options(),
    );
    await syncGarminHealthRecord(context.db, "dailies", { ...base, steps: 4000 }, options());
    await syncGarminHealthRecord(
      context.db,
      "hrv",
      { ...base, summaryId: "nightly-hrv", lastNightAvg: 48 },
      options(),
    );

    const rows = await context.db.select().from(dailyMetrics);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: TEST_USER_ID,
      providerId: "garmin",
      date: base.calendarDate,
      hrv: 48,
      steps: 4000,
      distanceKm: 2,
      flightsClimbed: 5,
      exerciseMinutes: 70,
      activeEnergyKcal: null,
      basalEnergyKcal: null,
    });
  });

  it("preserves missing daily values and clears an explicitly null metric", async () => {
    await syncGarminHealthRecord(
      context.db,
      "dailies",
      { ...base, steps: 3000, distanceInMeters: 1000 },
      options(),
    );
    await syncGarminHealthRecord(context.db, "dailies", { ...base, steps: null }, options());
    const [row] = await context.db.select().from(dailyMetrics);
    expect(row).toMatchObject({ steps: null, distanceKm: 1 });
  });

  it("preserves exercise minutes when an intensity contribution is missing and clears explicit unknowns", async () => {
    await syncGarminHealthRecord(
      context.db,
      "dailies",
      {
        ...base,
        moderateIntensityDurationInSeconds: 1800,
        vigorousIntensityDurationInSeconds: 2400,
      },
      options(),
    );
    await syncGarminHealthRecord(
      context.db,
      "dailies",
      {
        ...base,
        moderateIntensityDurationInSeconds: 600,
        activeTimeInSeconds: 9999,
      },
      options(),
    );
    const [sparse] = await context.db.select().from(dailyMetrics);
    expect(sparse?.exerciseMinutes).toBe(70);
    await syncGarminHealthRecord(
      context.db,
      "dailies",
      {
        ...base,
        moderateIntensityDurationInSeconds: null,
      },
      options(),
    );
    const [cleared] = await context.db.select().from(dailyMetrics);
    expect(cleared?.exerciseMinutes).toBeNull();
  });

  it("keeps another owner's summaries separate even when external summary IDs match", async () => {
    const otherUser = "63000000-0000-4000-8000-000000000001";
    await context.db
      .insert(userProfile)
      .values({ id: otherUser, name: "Other Garmin owner" })
      .onConflictDoNothing();
    await ensureProvider(context.db, "garmin", "Garmin", undefined, otherUser);
    await syncGarminHealthRecord(context.db, "hrv", { ...base, lastNightAvg: 40 }, options());
    await syncGarminHealthRecord(
      context.db,
      "hrv",
      { ...base, userId: "other-garmin-owner", lastNightAvg: 50 },
      options(otherUser),
    );
    const rows = await context.db.select().from(dailyMetrics).orderBy(dailyMetrics.userId);
    expect(rows.map((row) => ({ userId: row.userId, hrv: row.hrv }))).toEqual([
      { userId: TEST_USER_ID, hrv: 40 },
      { userId: otherUser, hrv: 50 },
    ]);
  });

  it("replaces corrected daily heart-rate samples in a stable owner/feed scope", async () => {
    await syncGarminHealthRecord(
      context.db,
      "dailies",
      { ...base, timeOffsetHeartRateSamples: { "15": 60, "30": 70 } },
      options(),
    );
    await syncGarminHealthRecord(
      context.db,
      "dailies",
      { ...base, timeOffsetHeartRateSamples: { "15": 65 } },
      options(),
    );
    expect(capture.deletedMetricStreamScopes).toEqual([
      {
        userId: TEST_USER_ID,
        providerId: "garmin",
        externalId: "dailies:health-summary",
        channel: "heart_rate",
      },
      {
        userId: TEST_USER_ID,
        providerId: "garmin",
        externalId: "dailies:health-summary",
        channel: "heart_rate",
      },
    ]);
    expect(
      capture.publishedMetricStreamRows.map((row) => ({
        channel: row.channel,
        scalar: row.scalar,
        recordedAt: row.recordedAt,
      })),
    ).toEqual([
      {
        channel: "heart_rate",
        scalar: 60,
        recordedAt: new Date((base.startTimeInSeconds + 15) * 1000).toISOString(),
      },
      {
        channel: "heart_rate",
        scalar: 70,
        recordedAt: new Date((base.startTimeInSeconds + 30) * 1000).toISOString(),
      },
      {
        channel: "heart_rate",
        scalar: 65,
        recordedAt: new Date((base.startTimeInSeconds + 15) * 1000).toISOString(),
      },
    ]);
    await syncGarminHealthRecord(context.db, "dailies", { ...base, steps: 4000 }, options());
    expect(capture.deletedMetricStreamScopes).toHaveLength(2);
    await syncGarminHealthRecord(
      context.db,
      "dailies",
      { ...base, timeOffsetHeartRateSamples: {} },
      options(),
    );
    expect(capture.deletedMetricStreamScopes).toHaveLength(3);
  });

  it("stores raw pulse-ox and respiration readings without inventing daily aggregates", async () => {
    await syncGarminHealthRecord(context.db, "hrv", { ...base, lastNightAvg: 44 }, options());
    await syncGarminHealthRecord(
      context.db,
      "pulseox",
      {
        ...base,
        summaryId: "oxygen",
        durationInSeconds: 0,
        onDemand: true,
        timeOffsetSpo2Values: { "300": 94, "360": 98 },
      },
      options(),
    );
    const respiration = {
      ...base,
      summaryId: "breathing",
      timeOffsetEpochToBreaths: { "0": 14.5, "60": 16.25 },
    };
    await syncGarminHealthRecord(context.db, "allDayRespiration", respiration, options());
    const [daily] = await context.db.select().from(dailyMetrics);
    expect(daily).toMatchObject({ hrv: 44, spo2Avg: null, respiratoryRateAvg: null });
    expect(
      capture.publishedMetricStreamRows.map((row) => ({
        channel: row.channel,
        scalar: row.scalar,
      })),
    ).toEqual([
      { channel: "spo2", scalar: 94 },
      { channel: "spo2", scalar: 98 },
      { channel: "respiratory_rate", scalar: 14.5 },
      { channel: "respiratory_rate", scalar: 16.25 },
    ]);
    expect(capture.publishedMetricStreamRows[0]?.recordedAt).toEqual(
      new Date((base.startTimeInSeconds + 300) * 1000).toISOString(),
    );
  });

  it("keeps sleep wall time, provider offset and corrected stage replacements", async () => {
    const start = base.startTimeInSeconds;
    const provisional = {
      ...base,
      summaryId: "sleep",
      durationInSeconds: 3600,
      awakeDurationInSeconds: 600,
      deepSleepDurationInSeconds: 600,
      validation: "AUTO_TENTATIVE",
      sleepLevelsMap: { deep: [{ startTimeInSeconds: start, endTimeInSeconds: start + 600 }] },
    };
    await syncGarminHealthRecord(context.db, "sleeps", provisional, options());
    const [initial] = await context.db.select().from(sleepSession);
    expect(initial).toMatchObject({
      startedAt: new Date(start * 1000),
      endedAt: new Date((start + 4200) * 1000),
      durationMinutes: 60,
      awakeMinutes: 10,
      deepMinutes: 10,
      stagingAvailable: true,
      startUtcOffsetMinutes: -420,
      localTimeSource: "provider_offset",
    });
    await syncGarminHealthRecord(
      context.db,
      "sleeps",
      {
        ...provisional,
        durationInSeconds: 7200,
        validation: "AUTO_FINAL",
        sleepLevelsMap: { light: [{ startTimeInSeconds: start, endTimeInSeconds: start + 1200 }] },
      },
      options(),
    );
    const [corrected] = await context.db.select().from(sleepSession);
    expect(corrected).toMatchObject({
      id: initial?.id,
      durationMinutes: 120,
      endedAt: new Date((start + 7800) * 1000),
    });
    const stages = await context.db.select().from(sleepStage);
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({
      sessionId: initial?.id,
      stage: "light",
      endedAt: new Date((start + 1200) * 1000),
    });
  });

  it("preserves a missing sleep timeline and removes an explicitly empty replacement", async () => {
    const start = base.startTimeInSeconds;
    await syncGarminHealthRecord(
      context.db,
      "sleeps",
      {
        ...base,
        sleepLevelsMap: {
          deep: [{ startTimeInSeconds: start, endTimeInSeconds: start + 600 }],
        },
      },
      options(),
    );
    await syncGarminHealthRecord(
      context.db,
      "sleeps",
      { ...base, durationInSeconds: 3600 },
      options(),
    );
    expect(await context.db.select().from(sleepStage)).toHaveLength(1);
    await syncGarminHealthRecord(context.db, "sleeps", { ...base, sleepLevelsMap: {} }, options());
    expect(await context.db.select().from(sleepStage)).toHaveLength(0);
    const [session] = await context.db.select().from(sleepSession);
    expect(session?.stagingAvailable).toBe(false);
    expect(session?.endedAt).toBeNull();
  });

  it.each([601, 629])(
    "preserves exact sleep wall time when a correction omits %i awake seconds",
    async (awakeDurationInSeconds) => {
      const start = base.startTimeInSeconds;
      await syncGarminHealthRecord(
        context.db,
        "sleeps",
        { ...base, durationInSeconds: 3601, awakeDurationInSeconds },
        options(),
      );
      await syncGarminHealthRecord(
        context.db,
        "sleeps",
        { ...base, durationInSeconds: 7203 },
        options(),
      );
      const [session] = await context.db.select().from(sleepSession);
      expect(session).toMatchObject({
        endedAt: new Date((start + 3601 + awakeDurationInSeconds) * 1000),
        durationMinutes: 120,
        awakeMinutes: 10,
      });
    },
  );

  it("preserves the last known wall end across sparse sleep corrections and clears explicit unknowns", async () => {
    const start = base.startTimeInSeconds;
    await syncGarminHealthRecord(
      context.db,
      "sleeps",
      {
        ...base,
        durationInSeconds: 3600,
        awakeDurationInSeconds: 600,
      },
      options(),
    );
    await syncGarminHealthRecord(
      context.db,
      "sleeps",
      {
        ...base,
        durationInSeconds: 7200,
      },
      options(),
    );
    const [sparse] = await context.db.select().from(sleepSession);
    expect(sparse).toMatchObject({
      awakeMinutes: 10,
      durationMinutes: 120,
      endedAt: new Date((start + 4200) * 1000),
    });
    await syncGarminHealthRecord(
      context.db,
      "sleeps",
      {
        ...base,
        durationInSeconds: 7200,
        awakeDurationInSeconds: null,
      },
      options(),
    );
    const [cleared] = await context.db.select().from(sleepSession);
    expect(cleared).toMatchObject({ awakeMinutes: null, endedAt: null });
  });

  it("rolls back a corrected sleep session if writing its replacement stages fails", async () => {
    const start = base.startTimeInSeconds;
    await syncGarminHealthRecord(
      context.db,
      "sleeps",
      { ...base, durationInSeconds: 3600 },
      options(),
    );
    await context.db.execute(
      `CREATE FUNCTION fitness.reject_test_stage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'stage write rejected'; END $$`,
    );
    await context.db.execute(
      `CREATE TRIGGER reject_test_stage BEFORE INSERT ON fitness.sleep_stage FOR EACH ROW EXECUTE FUNCTION fitness.reject_test_stage()`,
    );
    try {
      await expect(
        syncGarminHealthRecord(
          context.db,
          "sleeps",
          {
            ...base,
            durationInSeconds: 7200,
            sleepLevelsMap: {
              deep: [{ startTimeInSeconds: start, endTimeInSeconds: start + 600 }],
            },
          },
          options(),
        ),
      ).rejects.toThrow();
      const [session] = await context.db
        .select()
        .from(sleepSession)
        .where(
          and(eq(sleepSession.userId, TEST_USER_ID), eq(sleepSession.externalId, base.summaryId)),
        );
      expect(session?.durationMinutes).toBe(60);
    } finally {
      await context.db.execute(`DROP TRIGGER reject_test_stage ON fitness.sleep_stage`);
      await context.db.execute(`DROP FUNCTION fitness.reject_test_stage()`);
    }
  });
});
