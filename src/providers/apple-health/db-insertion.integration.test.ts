import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../../db/schema.ts";
import { setupTestDatabase, type TestContext } from "../../db/test-helpers.ts";
import {
  aggregateSkinTempToDailyMetrics,
  aggregateSpO2ToDailyMetrics,
  insertWithDuplicateDiag,
  upsertDailyMetricsBatch,
  upsertHealthEventBatch,
  upsertMetricStreamBatch,
  upsertSleepBatch,
  upsertWorkoutBatch,
} from "./db-insertion.ts";
import type { HealthRecord } from "./records.ts";
import type { SleepAnalysisRecord } from "./sleep.ts";
import type { HealthWorkout } from "./workouts.ts";

const PROVIDER_ID = "apple_health";

let ctx: TestContext;

describe("db-insertion deduplication (integration)", () => {
  beforeAll(async () => {
    ctx = await setupTestDatabase();

    await ctx.db.insert(schema.provider).values({
      id: PROVIDER_ID,
      name: "Apple Health",
    });
  }, 60_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  describe("upsertWorkoutBatch", () => {
    it("deduplicates workouts with the same startDate in a single batch", async () => {
      const sharedStart = new Date("2024-06-01T08:00:00Z");
      const sharedEnd = new Date("2024-06-01T08:30:00Z");

      const workouts: HealthWorkout[] = [
        {
          activityType: "running",
          sourceName: "Apple Watch",
          durationSeconds: 1800,
          startDate: sharedStart,
          endDate: sharedEnd,
          calories: 300,
        },
        {
          activityType: "running",
          sourceName: "iPhone",
          durationSeconds: 1800,
          startDate: sharedStart,
          endDate: sharedEnd,
          calories: 310,
        },
      ];

      const count = await upsertWorkoutBatch(ctx.db, PROVIDER_ID, workouts);

      // Only 1 workout should be inserted (the second duplicate wins the Map dedup)
      expect(count).toBe(1);

      const matching = await ctx.db
        .select()
        .from(schema.activity)
        .where(eq(schema.activity.externalId, `ah:workout:${sharedStart.toISOString()}`));

      expect(matching).toHaveLength(1);
    });

    it("preserves unique workouts while deduplicating duplicates", async () => {
      const start1 = new Date("2024-07-01T08:00:00Z");
      const start2 = new Date("2024-07-01T10:00:00Z");

      const workouts: HealthWorkout[] = [
        {
          activityType: "running",
          sourceName: "Apple Watch",
          durationSeconds: 1800,
          startDate: start1,
          endDate: new Date("2024-07-01T08:30:00Z"),
        },
        {
          activityType: "running",
          sourceName: "iPhone",
          durationSeconds: 1800,
          startDate: start1,
          endDate: new Date("2024-07-01T08:30:00Z"),
        },
        {
          activityType: "cycling",
          sourceName: "Apple Watch",
          durationSeconds: 3600,
          startDate: start2,
          endDate: new Date("2024-07-01T11:00:00Z"),
        },
      ];

      const count = await upsertWorkoutBatch(ctx.db, PROVIDER_ID, workouts);

      // 2 unique workouts (the two running dupes collapse into 1, plus the cycling)
      expect(count).toBe(2);
    });
  });

  describe("insertWithDuplicateDiag — safety net dedup", () => {
    it("deduplicates and retries when batch has duplicate conflict keys", async () => {
      const time1 = new Date("2025-01-15T08:00:00Z");
      const time2 = new Date("2025-01-15T08:00:00Z"); // same timestamp = same externalId

      const rows: (typeof schema.bodyMeasurement.$inferInsert)[] = [
        {
          providerId: PROVIDER_ID,
          externalId: "dup-test-key",
          recordedAt: time1,
          weightKg: 80,
          sourceName: "Scale A",
        },
        {
          providerId: PROVIDER_ID,
          externalId: "dup-test-key", // duplicate conflict key
          recordedAt: time2,
          weightKg: 81,
          sourceName: "Scale B",
        },
      ];

      // insertWithDuplicateDiag should deduplicate and retry instead of crashing
      await insertWithDuplicateDiag(
        "body_measurement",
        (row) => `${row.providerId}:${row.externalId}`,
        rows,
        (batch) =>
          ctx.db
            .insert(schema.bodyMeasurement)
            .values(batch)
            .onConflictDoUpdate({
              target: [
                schema.bodyMeasurement.userId,
                schema.bodyMeasurement.providerId,
                schema.bodyMeasurement.externalId,
              ],
              set: {
                weightKg: sql`excluded.weight_kg`,
                sourceName: sql`excluded.source_name`,
              },
            }),
      );

      // Should have inserted the deduplicated row (last one wins)
      const result = await ctx.db
        .select()
        .from(schema.bodyMeasurement)
        .where(eq(schema.bodyMeasurement.externalId, "dup-test-key"));

      expect(result).toHaveLength(1);
      expect(Number(result[0]?.weightKg)).toBe(81); // last duplicate wins
    });
  });

  describe("upsertMetricStreamBatch", () => {
    it("routes supported quantity records into metric_stream channels", async () => {
      const recordedAt = new Date("2025-09-01T08:00:00Z");
      const records: HealthRecord[] = [
        healthRecord("HKQuantityTypeIdentifierHeartRate", 62.4, recordedAt, "count/min"),
        healthRecord("HKQuantityTypeIdentifierOxygenSaturation", 0.97, recordedAt, "%"),
        healthRecord("HKQuantityTypeIdentifierRespiratoryRate", 14.2, recordedAt, "count/min"),
        healthRecord("HKQuantityTypeIdentifierBloodGlucose", 91, recordedAt, "mg/dL"),
        healthRecord(
          "HKQuantityTypeIdentifierEnvironmentalAudioExposure",
          55,
          recordedAt,
          "dBASPL",
        ),
        healthRecord(
          "HKQuantityTypeIdentifierAppleSleepingWristTemperature",
          33.7,
          recordedAt,
          "degC",
        ),
        healthRecord("HKQuantityTypeIdentifierElectrodermalActivity", 0.42, recordedAt, "uS"),
        healthRecord("HKQuantityTypeIdentifierStepCount", 123, recordedAt, "count"),
      ];

      const count = await upsertMetricStreamBatch(ctx.db, PROVIDER_ID, records);

      expect(count).toBe(7);

      const rows = await ctx.db
        .select({
          channel: schema.metricStream.channel,
          scalar: schema.metricStream.scalar,
          deviceId: schema.metricStream.deviceId,
        })
        .from(schema.metricStream)
        .where(sql`${schema.metricStream.recordedAt} = ${recordedAt.toISOString()}::timestamptz`);

      expect(rows).toHaveLength(7);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ channel: "heart_rate", scalar: 62 }),
          expect.objectContaining({ channel: "spo2", scalar: 0.97 }),
          expect.objectContaining({ channel: "respiratory_rate", scalar: 14.2 }),
          expect.objectContaining({ channel: "blood_glucose", scalar: 91 }),
          expect.objectContaining({ channel: "audio_exposure", scalar: 55 }),
          expect.objectContaining({ channel: "skin_temperature", scalar: 33.7 }),
          expect.objectContaining({ channel: "electrodermal_activity", scalar: 0.42 }),
        ]),
      );
      expect(rows.every((row) => row.deviceId === "Apple Watch")).toBe(true);
    });
  });

  describe("upsertDailyMetricsBatch", () => {
    it("keeps additive daily metrics separated by source", async () => {
      const date = new Date("2025-09-02T10:00:00Z");
      const records: HealthRecord[] = [
        healthRecord("HKQuantityTypeIdentifierStepCount", 1000, date, "count", "Apple Watch"),
        healthRecord(
          "HKQuantityTypeIdentifierStepCount",
          2000,
          new Date("2025-09-02T11:00:00Z"),
          "count",
          "Apple Watch",
        ),
        healthRecord("HKQuantityTypeIdentifierStepCount", 5000, date, "count", "iPhone"),
      ];

      const count = await upsertDailyMetricsBatch(ctx.db, PROVIDER_ID, records);

      expect(count).toBe(2);

      const rows = await ctx.db
        .select({
          sourceName: schema.dailyMetrics.sourceName,
          steps: schema.dailyMetrics.steps,
        })
        .from(schema.dailyMetrics)
        .where(eq(schema.dailyMetrics.date, "2025-09-02"))
        .orderBy(schema.dailyMetrics.sourceName);

      expect(rows).toEqual([
        { sourceName: "Apple Watch", steps: 3000 },
        { sourceName: "iPhone", steps: 5000 },
      ]);
    });

    it("does not store provider VO2 max or resting heart rate as daily metrics", async () => {
      const date = new Date("2025-09-03T06:00:00Z");
      const records: HealthRecord[] = [
        healthRecord("HKQuantityTypeIdentifierRestingHeartRate", 52, date, "count/min"),
        healthRecord("HKQuantityTypeIdentifierVO2Max", 48.5, date, "mL/min/kg"),
      ];

      const dailyCount = await upsertDailyMetricsBatch(ctx.db, PROVIDER_ID, records);
      const eventCount = await upsertHealthEventBatch(ctx.db, PROVIDER_ID, records);

      expect(dailyCount).toBe(0);
      expect(eventCount).toBe(2);

      const dailyRows = await ctx.db
        .select()
        .from(schema.dailyMetrics)
        .where(eq(schema.dailyMetrics.date, "2025-09-03"));
      expect(dailyRows).toHaveLength(0);

      const eventRows = await ctx.db
        .select({
          type: schema.healthEvent.type,
          value: schema.healthEvent.value,
        })
        .from(schema.healthEvent)
        .where(sql`${schema.healthEvent.startDate} = ${date.toISOString()}::timestamptz`)
        .orderBy(schema.healthEvent.type);

      expect(eventRows).toEqual([
        { type: "HKQuantityTypeIdentifierRestingHeartRate", value: 52 },
        { type: "HKQuantityTypeIdentifierVO2Max", value: 48.5 },
      ]);
    });
  });

  describe("upsertSleepBatch", () => {
    it("deduplicates inBed records with the same startDate in a single batch", async () => {
      const bedStart = new Date("2024-06-15T23:00:00Z");
      const bedEnd = new Date("2024-06-16T07:00:00Z");
      const durationMinutes = 480;

      const records: SleepAnalysisRecord[] = [
        {
          stage: "inBed",
          sourceName: "Apple Watch",
          startDate: bedStart,
          endDate: bedEnd,
          durationMinutes,
        },
        {
          stage: "inBed",
          sourceName: "iPhone",
          startDate: bedStart,
          endDate: bedEnd,
          durationMinutes,
        },
        {
          stage: "deep",
          sourceName: "Apple Watch",
          startDate: new Date("2024-06-16T00:00:00Z"),
          endDate: new Date("2024-06-16T01:30:00Z"),
          durationMinutes: 90,
        },
        {
          stage: "rem",
          sourceName: "Apple Watch",
          startDate: new Date("2024-06-16T01:30:00Z"),
          endDate: new Date("2024-06-16T03:00:00Z"),
          durationMinutes: 90,
        },
      ];

      const count = await upsertSleepBatch(ctx.db, PROVIDER_ID, records);

      // Only 1 sleep session (2 duplicate inBed records collapse into 1)
      expect(count).toBe(1);

      const matching = await ctx.db
        .select()
        .from(schema.sleepSession)
        .where(eq(schema.sleepSession.externalId, `ah:sleep:${bedStart.toISOString()}`));

      expect(matching).toHaveLength(1);
      // Stage aggregation should still work on the deduplicated session
      expect(matching[0]?.deepMinutes).toBe(90);
      expect(matching[0]?.remMinutes).toBe(90);
    });

    it("preserves unique sleep sessions while deduplicating duplicates", async () => {
      const bedStart1 = new Date("2024-07-15T23:00:00Z");
      const bedStart2 = new Date("2024-07-16T23:00:00Z");

      const records: SleepAnalysisRecord[] = [
        {
          stage: "inBed",
          sourceName: "Apple Watch",
          startDate: bedStart1,
          endDate: new Date("2024-07-16T07:00:00Z"),
          durationMinutes: 480,
        },
        {
          stage: "inBed",
          sourceName: "iPhone",
          startDate: bedStart1,
          endDate: new Date("2024-07-16T07:00:00Z"),
          durationMinutes: 480,
        },
        {
          stage: "inBed",
          sourceName: "Apple Watch",
          startDate: bedStart2,
          endDate: new Date("2024-07-17T06:30:00Z"),
          durationMinutes: 450,
        },
      ];

      const count = await upsertSleepBatch(ctx.db, PROVIDER_ID, records);

      // 2 unique sessions (the two duplicate night-1 records collapse into 1, plus night-2)
      expect(count).toBe(2);
    });
  });

  describe("aggregateSpO2ToDailyMetrics", () => {
    it("aggregates SpO2 fractions from metric_stream into daily_metrics as percentage", async () => {
      // Insert SpO2 readings as fractions (0-1) into metric_stream
      await ctx.db.insert(schema.metricStream).values([
        {
          providerId: PROVIDER_ID,
          userId: schema.TEST_USER_ID,
          recordedAt: new Date("2025-08-01T08:00:00Z"),
          channel: "spo2",
          scalar: 0.96,
          sourceType: "api",
          deviceId: "Apple Watch",
        },
        {
          providerId: PROVIDER_ID,
          userId: schema.TEST_USER_ID,
          recordedAt: new Date("2025-08-01T14:00:00Z"),
          channel: "spo2",
          scalar: 0.98,
          sourceType: "api",
          deviceId: "Apple Watch",
        },
        {
          providerId: PROVIDER_ID,
          userId: schema.TEST_USER_ID,
          recordedAt: new Date("2025-08-01T20:00:00Z"),
          channel: "spo2",
          scalar: 0.97,
          sourceType: "api",
          deviceId: "Apple Watch",
        },
      ]);

      await aggregateSpO2ToDailyMetrics(ctx.db, PROVIDER_ID, new Date("2025-08-01T00:00:00Z"));

      const rows = await ctx.db
        .select({ spo2Avg: schema.dailyMetrics.spo2Avg })
        .from(schema.dailyMetrics)
        .where(eq(schema.dailyMetrics.date, "2025-08-01"));

      expect(rows).toHaveLength(1);
      // Average of 0.96, 0.98, 0.97 = 0.97 → 97% on 0-100 scale
      expect(rows[0]?.spo2Avg).toBeCloseTo(97, 0);
    });
  });

  describe("aggregateSkinTempToDailyMetrics", () => {
    it("aggregates wrist temperature from metric_stream into daily_metrics", async () => {
      // Insert skin temperature readings into metric_stream
      await ctx.db.insert(schema.metricStream).values([
        {
          providerId: PROVIDER_ID,
          userId: schema.TEST_USER_ID,
          recordedAt: new Date("2025-08-02T02:00:00Z"),
          channel: "skin_temperature",
          scalar: 33.2,
          sourceType: "api",
          deviceId: "Apple Watch",
        },
        {
          providerId: PROVIDER_ID,
          userId: schema.TEST_USER_ID,
          recordedAt: new Date("2025-08-02T04:00:00Z"),
          channel: "skin_temperature",
          scalar: 33.6,
          sourceType: "api",
          deviceId: "Apple Watch",
        },
      ]);

      await aggregateSkinTempToDailyMetrics(ctx.db, PROVIDER_ID, new Date("2025-08-02T00:00:00Z"));

      const rows = await ctx.db
        .select({ skinTempC: schema.dailyMetrics.skinTempC })
        .from(schema.dailyMetrics)
        .where(eq(schema.dailyMetrics.date, "2025-08-02"));

      expect(rows).toHaveLength(1);
      // Average of 33.2 and 33.6 = 33.4
      expect(rows[0]?.skinTempC).toBeCloseTo(33.4, 1);
    });
  });
});

function healthRecord(
  type: string,
  value: number,
  startDate: Date,
  unit: string,
  sourceName = "Apple Watch",
): HealthRecord {
  return {
    type,
    sourceName,
    unit,
    value,
    startDateCalendarDay: startDate.toISOString().slice(0, 10),
    startDate,
    endDate: startDate,
    creationDate: startDate,
  };
}
