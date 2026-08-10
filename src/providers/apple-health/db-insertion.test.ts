import { resolveProviderActivityType } from "@dofek/training/activity-types";
import type { SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../../db/index.ts";
import { runWithTokenUser } from "../../db/token-user-context.ts";
import { makeTransactionalTestDatabase } from "../test-helpers.ts";
import {
  ALL_ROUTED_TYPES,
  BODY_MEASUREMENT_TYPES,
  DAILY_METRIC_TYPES,
  IGNORED_PROVIDER_DERIVED_TYPES,
  insertWithDuplicateDiag,
  METRIC_STREAM_TYPES,
  NUTRITION_TYPES,
  upsertBodyMeasurementBatch,
  upsertDailyMetricsBatch,
  upsertHealthEventBatch,
  upsertMetricStreamBatch,
  upsertNutritionBatch,
  upsertSleepBatch,
  upsertWorkoutBatch,
} from "./db-insertion.ts";
import { type HealthRecord, parseRecord } from "./records.ts";
import type { SleepAnalysisRecord } from "./sleep.ts";
import type { HealthWorkout } from "./workouts.ts";

vi.mock("../../db/provider-data-deletion.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../db/provider-data-deletion.ts")>();
  const { resolveProviderDataGenerationsForTest } = await import("./test-helpers.ts");
  return { ...actual, getProviderDataGenerations: resolveProviderDataGenerationsForTest };
});

const { metricStreamCapture } = vi.hoisted<{
  metricStreamCapture: {
    current: {
      values: Record<string, unknown>[][];
      partitionKeys: Array<string | undefined>;
    } | null;
  };
}>(() => ({
  metricStreamCapture: {
    current: null,
  },
}));

const providerActivityAbsenceMocks = vi.hoisted(() => ({
  upsertProviderActivity: vi.fn(),
}));

vi.mock("../../metric-stream/redpanda-producer.ts", () => ({
  getDefaultMetricStreamEventPublisher: async () => ({
    publishRows: async (
      rows: readonly Record<string, unknown>[],
      options: { partitionKey?: string },
    ) => {
      metricStreamCapture.current?.values.push([...rows]);
      metricStreamCapture.current?.partitionKeys.push(options.partitionKey);
      return rows.map((row, index) => ({
        version: 1,
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        recordedAt: row.recordedAt instanceof Date ? row.recordedAt.toISOString() : row.recordedAt,
      }));
    },
    replaceRows: async (_scope: unknown, rows: readonly Record<string, unknown>[]) => {
      metricStreamCapture.current?.values.push([...rows]);
      return {
        deleted: {
          version: 1,
          eventType: "metric_stream_deleted",
          scope: _scope,
          partitionKey: "test-partition",
        },
        rows: rows.map((row, index) => ({
          version: 1,
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          recordedAt:
            row.recordedAt instanceof Date ? row.recordedAt.toISOString() : row.recordedAt,
        })),
      };
    },
  }),
}));

vi.mock("../../db/token-user-context.ts", () => ({
  getTokenUserId: () => "00000000-0000-0000-0000-000000000001",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

vi.mock("../../db/provider-activity-sync.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../db/provider-activity-sync.ts")>();
  return {
    ...original,
    upsertProviderActivity: providerActivityAbsenceMocks.upsertProviderActivity,
  };
});

// ---------------------------------------------------------------------------
// Mock DB helper
// ---------------------------------------------------------------------------

interface MockInsertCapture {
  values: Record<string, unknown>[][];
  executions: { sql: string; params: unknown[] }[];
  partitionKeys: Array<string | undefined>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findActivityUpsertValues(
  predicate: (values: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  for (const call of providerActivityAbsenceMocks.upsertProviderActivity.mock.calls) {
    const values = call[1];
    if (isRecord(values) && predicate(values)) return values;
  }
  return undefined;
}

function createMockDb(returningData: Record<string, unknown>[] = []): {
  db: SyncDatabase;
  capture: MockInsertCapture;
} {
  const capture: MockInsertCapture = { values: [], executions: [], partitionKeys: [] };
  const dialect = new PgDialect();
  metricStreamCapture.current = capture;

  let returnIndex = 0;
  providerActivityAbsenceMocks.upsertProviderActivity.mockReset();
  providerActivityAbsenceMocks.upsertProviderActivity.mockImplementation(async () => {
    const template = returningData[returnIndex] ??
      returningData[returningData.length - 1] ?? { id: "10000000-0000-4000-8000-000000000001" };
    returnIndex += 1;
    if (template.id === undefined) return undefined;
    return { id: String(template.id) };
  });

  function makeChainable(): Promise<undefined> {
    return Object.assign(Promise.resolve(undefined), {
      values: vi.fn((rows: Record<string, unknown>[]) => {
        capture.values.push(rows);
        return makeChainable();
      }),
      onConflictDoUpdate: vi.fn(() => makeChainable()),
      onConflictDoNothing: vi.fn(() => makeChainable()),
      returning: vi.fn(() => Promise.resolve(returningData)),
    });
  }

  const insertFn = vi.fn();
  insertFn.mockImplementation(() => makeChainable());

  const selectChain = {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
    }),
  };

  const deleteChain = {
    where: vi.fn().mockResolvedValue(undefined),
  };

  const db = makeTransactionalTestDatabase<SyncDatabase>({
    select: vi.fn().mockReturnValue(selectChain),
    insert: insertFn,
    delete: vi.fn().mockReturnValue(deleteChain),
    execute: vi.fn((query: SQLWrapper | string) => {
      const compiled =
        typeof query === "string" ? { sql: query, params: [] } : dialect.sqlToQuery(query.getSQL());
      capture.executions.push({ sql: compiled.sql, params: compiled.params });
      return Promise.resolve([]);
    }),
  });

  return { db, capture };
}

function findCapturedNutrient(
  capture: MockInsertCapture,
  nutrientId: string,
): Record<string, unknown> | undefined {
  return capture.values
    .flat()
    .find((row) => row.nutrientId === nutrientId || row.nutrient_id === nutrientId);
}

function makeRecord(overrides: Partial<HealthRecord> & { type: string }): HealthRecord {
  return {
    sourceName: "Apple Watch",
    unit: null,
    value: 0,
    startDate: new Date("2024-03-01T10:00:00Z"),
    endDate: new Date("2024-03-01T10:00:05Z"),
    creationDate: new Date("2024-03-01T10:00:00Z"),
    ...overrides,
  };
}

function makeWorkout(overrides: Partial<HealthWorkout> = {}): HealthWorkout {
  return {
    activityType: resolveProviderActivityType("HKWorkoutActivityTypeRunning", "running"),
    sourceName: "Apple Watch",
    durationSeconds: 1800,
    startDate: new Date("2024-03-01T18:00:00Z"),
    endDate: new Date("2024-03-01T18:30:00Z"),
    ...overrides,
  };
}

function makeSleep(overrides: Partial<SleepAnalysisRecord> = {}): SleepAnalysisRecord {
  return {
    stage: "inBed",
    sourceName: "Apple Watch",
    startDate: new Date("2024-03-01T23:00:00Z"),
    endDate: new Date("2024-03-02T07:00:00Z"),
    durationMinutes: 480,
    ...overrides,
  };
}

function expectedProviderPartitionKey(providerId: string, recordedAtStart: Date): string {
  return [
    "provider",
    "00000000-0000-0000-0000-000000000001",
    providerId,
    "*",
    "*",
    recordedAtStart.toISOString(),
    "*",
  ].join(":");
}

// ---------------------------------------------------------------------------
// Type maps / constants
// ---------------------------------------------------------------------------

describe("type routing constants", () => {
  it("METRIC_STREAM_TYPES maps HK types to field names", () => {
    expect(METRIC_STREAM_TYPES.HKQuantityTypeIdentifierHeartRate).toBe("heartRate");
    expect(METRIC_STREAM_TYPES.HKQuantityTypeIdentifierOxygenSaturation).toBe("spo2");
    expect(METRIC_STREAM_TYPES.HKQuantityTypeIdentifierRespiratoryRate).toBe("respiratoryRate");
    expect(METRIC_STREAM_TYPES.HKQuantityTypeIdentifierBloodGlucose).toBe("bloodGlucose");
    expect(METRIC_STREAM_TYPES.HKQuantityTypeIdentifierEnvironmentalAudioExposure).toBe(
      "audioExposure",
    );
    expect(METRIC_STREAM_TYPES.HKQuantityTypeIdentifierHeadphoneAudioExposure).toBe(
      "audioExposure",
    );
    expect(METRIC_STREAM_TYPES.HKQuantityTypeIdentifierAppleSleepingWristTemperature).toBe(
      "skinTemperature",
    );
    expect(METRIC_STREAM_TYPES.HKQuantityTypeIdentifierElectrodermalActivity).toBe(
      "electrodermalActivity",
    );
  });

  it("BODY_MEASUREMENT_TYPES contains expected types", () => {
    expect(BODY_MEASUREMENT_TYPES.has("HKQuantityTypeIdentifierBodyMass")).toBe(true);
    expect(BODY_MEASUREMENT_TYPES.has("HKQuantityTypeIdentifierBodyFatPercentage")).toBe(true);
    expect(BODY_MEASUREMENT_TYPES.has("HKQuantityTypeIdentifierBloodPressureSystolic")).toBe(true);
    expect(BODY_MEASUREMENT_TYPES.has("HKQuantityTypeIdentifierBloodPressureDiastolic")).toBe(true);
    expect(BODY_MEASUREMENT_TYPES.has("HKQuantityTypeIdentifierHeight")).toBe(true);
    expect(BODY_MEASUREMENT_TYPES.has("HKQuantityTypeIdentifierWaistCircumference")).toBe(true);
    expect(BODY_MEASUREMENT_TYPES.has("HKQuantityTypeIdentifierBodyTemperature")).toBe(true);
    expect(BODY_MEASUREMENT_TYPES.has("HKQuantityTypeIdentifierBodyMassIndex")).toBe(true);
    expect(BODY_MEASUREMENT_TYPES.has("HKQuantityTypeIdentifierLeanBodyMass")).toBe(true);
  });

  it("DAILY_METRIC_TYPES contains expected types", () => {
    expect(DAILY_METRIC_TYPES.has("HKQuantityTypeIdentifierRestingHeartRate")).toBe(false);
    expect(DAILY_METRIC_TYPES.has("HKQuantityTypeIdentifierStepCount")).toBe(true);
    expect(DAILY_METRIC_TYPES.has("HKQuantityTypeIdentifierVO2Max")).toBe(false);
    expect(DAILY_METRIC_TYPES.has("HKQuantityTypeIdentifierWalkingSpeed")).toBe(true);
  });

  it("NUTRITION_TYPES maps HK types to field names", () => {
    expect(NUTRITION_TYPES.HKQuantityTypeIdentifierDietaryEnergyConsumed).toBe("calories");
    expect(NUTRITION_TYPES.HKQuantityTypeIdentifierDietaryProtein).toBe("proteinG");
    expect(NUTRITION_TYPES.HKQuantityTypeIdentifierDietaryCarbohydrates).toBe("carbsG");
    expect(NUTRITION_TYPES.HKQuantityTypeIdentifierDietaryFatTotal).toBe("fatG");
    expect(NUTRITION_TYPES.HKQuantityTypeIdentifierDietaryFiber).toBe("fiberG");
    expect(NUTRITION_TYPES.HKQuantityTypeIdentifierDietaryWater).toBe("waterMl");
  });

  it("ALL_ROUTED_TYPES includes metric stream, body, daily, and nutrition types", () => {
    expect(ALL_ROUTED_TYPES.has("HKQuantityTypeIdentifierHeartRate")).toBe(true);
    expect(ALL_ROUTED_TYPES.has("HKQuantityTypeIdentifierBodyMass")).toBe(true);
    expect(ALL_ROUTED_TYPES.has("HKQuantityTypeIdentifierStepCount")).toBe(true);
    expect(ALL_ROUTED_TYPES.has("HKQuantityTypeIdentifierDietaryProtein")).toBe(true);
    expect(ALL_ROUTED_TYPES.has("HKCategoryTypeIdentifierSleepAnalysis")).toBe(true);
  });

  it("ALL_ROUTED_TYPES does not include unknown types", () => {
    expect(ALL_ROUTED_TYPES.has("SomeRandomType")).toBe(false);
  });

  it("ALL_ROUTED_TYPES includes ignored provider resting HR and VO2 Max summaries", () => {
    expect(IGNORED_PROVIDER_DERIVED_TYPES.has("HKQuantityTypeIdentifierRestingHeartRate")).toBe(
      true,
    );
    expect(ALL_ROUTED_TYPES.has("HKQuantityTypeIdentifierRestingHeartRate")).toBe(true);
    expect(ALL_ROUTED_TYPES.has("HKQuantityTypeIdentifierWalkingHeartRateAverage")).toBe(true);
    expect(IGNORED_PROVIDER_DERIVED_TYPES.has("HKQuantityTypeIdentifierVO2Max")).toBe(true);
    expect(ALL_ROUTED_TYPES.has("HKQuantityTypeIdentifierVO2Max")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// upsertMetricStreamBatch
// ---------------------------------------------------------------------------

describe("upsertMetricStreamBatch", () => {
  it("routes heart rate records with rounding", async () => {
    const { db, capture } = createMockDb();
    const records = [makeRecord({ type: "HKQuantityTypeIdentifierHeartRate", value: 72.6 })];

    const count = await upsertMetricStreamBatch(db, "p1", records);
    expect(count).toBe(1);
    expect(capture.values[0]?.[0]).toMatchObject({
      providerId: "p1",
      channel: "heart_rate",
      scalar: 73,
      sourceType: "file",
    });
  });

  it("routes spo2 records", async () => {
    const { db, capture } = createMockDb();
    const records = [makeRecord({ type: "HKQuantityTypeIdentifierOxygenSaturation", value: 0.97 })];

    await upsertMetricStreamBatch(db, "p1", records);
    expect(capture.values[0]?.[0]).toMatchObject({ channel: "spo2", scalar: 0.97 });
  });

  it("routes respiratory rate records", async () => {
    const { db, capture } = createMockDb();
    const records = [makeRecord({ type: "HKQuantityTypeIdentifierRespiratoryRate", value: 16.5 })];

    await upsertMetricStreamBatch(db, "p1", records);
    expect(capture.values[0]?.[0]).toMatchObject({ channel: "respiratory_rate", scalar: 16.5 });
  });

  it("routes blood glucose records", async () => {
    const { db, capture } = createMockDb();
    const records = [makeRecord({ type: "HKQuantityTypeIdentifierBloodGlucose", value: 5.4 })];

    await upsertMetricStreamBatch(db, "p1", records);
    expect(capture.values[0]?.[0]).toMatchObject({ channel: "blood_glucose", scalar: 5.4 });
  });

  it("routes audio exposure records", async () => {
    const { db, capture } = createMockDb();
    const records = [
      makeRecord({ type: "HKQuantityTypeIdentifierEnvironmentalAudioExposure", value: 68.2 }),
    ];

    await upsertMetricStreamBatch(db, "p1", records);
    expect(capture.values[0]?.[0]).toMatchObject({ channel: "audio_exposure", scalar: 68.2 });
  });

  it("routes headphone audio exposure to audioExposure", async () => {
    const { db, capture } = createMockDb();
    const records = [
      makeRecord({ type: "HKQuantityTypeIdentifierHeadphoneAudioExposure", value: 75 }),
    ];

    await upsertMetricStreamBatch(db, "p1", records);
    expect(capture.values[0]?.[0]).toMatchObject({ channel: "audio_exposure", scalar: 75 });
  });

  it("skips unknown record types", async () => {
    const { db } = createMockDb();
    const records = [makeRecord({ type: "UnknownType", value: 42 })];

    const count = await upsertMetricStreamBatch(db, "p1", records);
    expect(count).toBe(0);
  });

  it("includes sourceName and recordedAt in rows", async () => {
    const { db, capture } = createMockDb();
    const date = new Date("2024-06-15T12:00:00Z");
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierHeartRate",
        value: 72,
        sourceName: "My Watch",
        startDate: date,
      }),
    ];

    await upsertMetricStreamBatch(db, "p1", records);
    expect(capture.values[0]?.[0]).toMatchObject({
      deviceId: "My Watch",
      recordedAt: date.toISOString(),
    });
  });

  it("batches rows in groups of 1000", async () => {
    const { db, capture } = createMockDb();
    const records: HealthRecord[] = [];
    for (let i = 0; i < 1500; i++) {
      records.push(
        makeRecord({
          type: "HKQuantityTypeIdentifierHeartRate",
          value: 72,
          startDate: new Date(
            `2024-03-01T${String(Math.floor(i / 60) % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`,
          ),
        }),
      );
    }

    const count = await upsertMetricStreamBatch(db, "p1", records);
    expect(count).toBe(1500);
    expect(capture.values).toHaveLength(2);
    expect(capture.values[0]).toHaveLength(1000);
    expect(capture.values[1]).toHaveLength(500);
  });

  it("returns 0 and does not insert when no matching records", async () => {
    const { db, capture } = createMockDb();
    const count = await upsertMetricStreamBatch(db, "p1", []);
    expect(count).toBe(0);
    expect(capture.values).toHaveLength(0);
  });

  it("maps electrodermal activity to electrodermalActivity", async () => {
    const { db, capture } = createMockDb();
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierElectrodermalActivity",
        value: 0.5,
      }),
    ];

    await upsertMetricStreamBatch(db, "p1", records);
    expect(capture.values[0]?.[0]).toMatchObject({
      channel: "electrodermal_activity",
      scalar: 0.5,
    });
  });

  it("maps sleeping wrist temperature to skin temperature", async () => {
    const { db, capture } = createMockDb();
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierAppleSleepingWristTemperature",
        value: 33.4,
      }),
    ];

    const count = await upsertMetricStreamBatch(db, "p1", records);

    expect(count).toBe(1);
    expect(capture.values[0]?.[0]).toMatchObject({
      channel: "skin_temperature",
      scalar: 33.4,
    });
  });

  it("publishes records with the replacement scope partition key", async () => {
    const { db, capture } = createMockDb();
    const recordedAtStart = new Date("2024-01-01T00:00:00Z");
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierHeartRate",
        value: 72,
      }),
    ];

    await upsertMetricStreamBatch(db, "p1", records, {
      userId: "00000000-0000-0000-0000-000000000001",
      providerId: "p1",
      recordedAtStart,
    });

    expect(capture.partitionKeys).toContain(expectedProviderPartitionKey("p1", recordedAtStart));
    expect(capture.values.flat()).toContainEqual(
      expect.objectContaining({
        providerId: "p1",
        channel: "heart_rate",
        scalar: 72,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// upsertBodyMeasurementBatch
// ---------------------------------------------------------------------------

describe("upsertBodyMeasurementBatch", () => {
  it("maps body mass to weightKg", async () => {
    const { db, capture } = createMockDb();
    const records = [makeRecord({ type: "HKQuantityTypeIdentifierBodyMass", value: 72.5 })];

    const count = await upsertBodyMeasurementBatch(db, "p1", records);
    expect(count).toBe(1);
    expect(capture.values.flat()).toContainEqual(
      expect.objectContaining({ channel: "body_weight", scalar: 72.5 }),
    );
  });

  it("mirrors body measurements to metric_stream channels", async () => {
    const { db, capture } = createMockDb();
    const records = [makeRecord({ type: "HKQuantityTypeIdentifierBodyMass", value: 72.5 })];

    await upsertBodyMeasurementBatch(db, "p1", records);

    expect(capture.values.flat()).toContainEqual(
      expect.objectContaining({
        providerId: "p1",
        sourceType: "file",
        channel: "body_weight",
        scalar: 72.5,
      }),
    );
  });

  it("converts body fat percentage to percent (x100)", async () => {
    const { db, capture } = createMockDb();
    const records = [
      makeRecord({ type: "HKQuantityTypeIdentifierBodyFatPercentage", value: 0.215 }),
    ];

    await upsertBodyMeasurementBatch(db, "p1", records);
    expect(capture.values.flat()).toContainEqual(
      expect.objectContaining({ channel: "body_fat_percentage", scalar: 21.5 }),
    );
  });

  it("maps BMI", async () => {
    const { db, capture } = createMockDb();
    const records = [makeRecord({ type: "HKQuantityTypeIdentifierBodyMassIndex", value: 24.5 })];

    await upsertBodyMeasurementBatch(db, "p1", records);
    expect(capture.values.flat()).toContainEqual(
      expect.objectContaining({ channel: "body_mass_index", scalar: 24.5 }),
    );
  });

  it("rounds BP values to integers", async () => {
    const { db, capture } = createMockDb();
    const date = new Date("2024-03-01T09:00:00Z");
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierBloodPressureSystolic",
        value: 119.7,
        startDate: date,
      }),
      makeRecord({
        type: "HKQuantityTypeIdentifierBloodPressureDiastolic",
        value: 79.3,
        startDate: date,
      }),
    ];

    await upsertBodyMeasurementBatch(db, "p1", records);
    expect(capture.values.flat()).toContainEqual(
      expect.objectContaining({ channel: "systolic_blood_pressure", scalar: 120 }),
    );
    expect(capture.values.flat()).toContainEqual(
      expect.objectContaining({ channel: "diastolic_blood_pressure", scalar: 79 }),
    );
  });

  it("groups BP records with the same timestamp into one row", async () => {
    const { db } = createMockDb();
    const date = new Date("2024-03-01T09:00:00Z");
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierBloodPressureSystolic",
        value: 120,
        startDate: date,
      }),
      makeRecord({
        type: "HKQuantityTypeIdentifierBloodPressureDiastolic",
        value: 80,
        startDate: date,
      }),
    ];

    const count = await upsertBodyMeasurementBatch(db, "p1", records);
    expect(count).toBe(1);
  });

  it("maps temperature", async () => {
    const { db, capture } = createMockDb();
    const records = [makeRecord({ type: "HKQuantityTypeIdentifierBodyTemperature", value: 36.6 })];

    await upsertBodyMeasurementBatch(db, "p1", records);
    expect(capture.values.flat()).toContainEqual(
      expect.objectContaining({ channel: "body_temperature", scalar: 36.6 }),
    );
  });

  it("converts height from meters to cm", async () => {
    const { db, capture } = createMockDb();
    const records = [
      makeRecord({ type: "HKQuantityTypeIdentifierHeight", value: 1.78, unit: "m" }),
    ];

    await upsertBodyMeasurementBatch(db, "p1", records);
    expect(capture.values.flat()).toContainEqual(
      expect.objectContaining({ channel: "height", scalar: 178 }),
    );
  });

  it("keeps height as-is when not in meters", async () => {
    const { db, capture } = createMockDb();
    const records = [
      makeRecord({ type: "HKQuantityTypeIdentifierHeight", value: 178, unit: "cm" }),
    ];

    await upsertBodyMeasurementBatch(db, "p1", records);
    expect(capture.values.flat()).toContainEqual(
      expect.objectContaining({ channel: "height", scalar: 178 }),
    );
  });

  it("converts waist circumference from meters to cm", async () => {
    const { db, capture } = createMockDb();
    const records = [
      makeRecord({ type: "HKQuantityTypeIdentifierWaistCircumference", value: 0.85, unit: "m" }),
    ];

    await upsertBodyMeasurementBatch(db, "p1", records);
    expect(capture.values.flat()).toContainEqual(
      expect.objectContaining({ channel: "waist_circumference", scalar: 85 }),
    );
  });

  it("keeps waist circumference as-is when not in meters", async () => {
    const { db, capture } = createMockDb();
    const records = [
      makeRecord({ type: "HKQuantityTypeIdentifierWaistCircumference", value: 85, unit: "cm" }),
    ];

    await upsertBodyMeasurementBatch(db, "p1", records);
    expect(capture.values.flat()).toContainEqual(
      expect.objectContaining({ channel: "waist_circumference", scalar: 85 }),
    );
  });

  it("generates externalId from startDate", async () => {
    const { db, capture } = createMockDb();
    const date = new Date("2024-06-15T08:00:00Z");
    const records = [
      makeRecord({ type: "HKQuantityTypeIdentifierBodyMass", value: 72, startDate: date }),
    ];

    await upsertBodyMeasurementBatch(db, "p1", records);
    expect(capture.values[0]?.[0]).toMatchObject({
      externalId: `ah:body:${date.toISOString()}`,
    });
  });

  it("deduplicates body measurements with the same timestamp from multiple sources", async () => {
    const { db } = createMockDb();
    const sharedDate = new Date("2024-06-01T08:00:00Z");
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierBodyMass",
        value: 72.5,
        startDate: sharedDate,
        sourceName: "Apple Watch",
      }),
      makeRecord({
        type: "HKQuantityTypeIdentifierBodyMass",
        value: 72.4,
        startDate: sharedDate,
        sourceName: "iPhone",
      }),
    ];

    // Both records have the same timestamp → same externalId → deduplicated to 1
    const count = await upsertBodyMeasurementBatch(db, "p1", records);
    expect(count).toBe(1);
  });

  it("skips non-body-measurement record types", async () => {
    const { db } = createMockDb();
    const records = [makeRecord({ type: "HKQuantityTypeIdentifierHeartRate", value: 72 })];

    const count = await upsertBodyMeasurementBatch(db, "p1", records);
    expect(count).toBe(0);
  });

  it("batches in groups of 500", async () => {
    const { db, capture } = createMockDb();
    const records: HealthRecord[] = [];
    for (let i = 0; i < 600; i++) {
      records.push(
        makeRecord({
          type: "HKQuantityTypeIdentifierBodyMass",
          value: 72,
          startDate: new Date(Date.UTC(2024, 0, 1, 0, 0, i)),
        }),
      );
    }

    await upsertBodyMeasurementBatch(db, "p1", records);
    expect(capture.values).toHaveLength(1);
    expect(capture.values[0]).toHaveLength(600);
  });

  it("publishes body measurements with the replacement scope partition key", async () => {
    const { db, capture } = createMockDb();
    const recordedAtStart = new Date("2024-01-01T00:00:00Z");
    const records = [makeRecord({ type: "HKQuantityTypeIdentifierBodyMass", value: 72.5 })];

    await upsertBodyMeasurementBatch(db, "p1", records, {
      userId: "00000000-0000-0000-0000-000000000001",
      providerId: "p1",
      recordedAtStart,
    });

    expect(capture.partitionKeys).toContain(expectedProviderPartitionKey("p1", recordedAtStart));
    expect(capture.values.flat()).toContainEqual(
      expect.objectContaining({
        providerId: "p1",
        channel: "body_weight",
        scalar: 72.5,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// upsertDailyMetricsBatch
// ---------------------------------------------------------------------------

describe("upsertDailyMetricsBatch", () => {
  it("uses the source calendar day for steps instead of UTC-shifted date", async () => {
    const { db, capture } = createMockDb();
    const parsedRecord = parseRecord({
      type: "HKQuantityTypeIdentifierStepCount",
      value: "3500",
      sourceName: "Apple Watch",
      unit: "count",
      // Local day is March 1, but UTC day is March 2.
      startDate: "2024-03-01 23:30:00 -0800",
      endDate: "2024-03-01 23:30:05 -0800",
      creationDate: "2024-03-01 23:31:00 -0800",
    });
    expect(parsedRecord).not.toBeNull();
    if (!parsedRecord) return;

    await upsertDailyMetricsBatch(db, "apple_health", [parsedRecord]);

    expect(capture.values[0]?.[0]).toMatchObject({ date: "2024-03-01", steps: 3500 });
  });

  it("sums additive types (steps) across records on the same day", async () => {
    const { db, capture } = createMockDb();
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierStepCount",
        value: 1250,
        startDate: new Date("2024-03-01T14:00:00Z"),
      }),
      makeRecord({
        type: "HKQuantityTypeIdentifierStepCount",
        value: 800,
        startDate: new Date("2024-03-01T15:00:00Z"),
      }),
    ];

    const count = await upsertDailyMetricsBatch(db, "p1", records);
    expect(count).toBe(1);
    expect(capture.values[0]?.[0]).toMatchObject({ steps: 2050, date: "2024-03-01" });
  });

  it("ignores provider resting HR as a daily metric", async () => {
    const { db, capture } = createMockDb();
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierRestingHeartRate",
        value: 52,
        startDate: new Date("2024-03-01T06:00:00Z"),
      }),
      makeRecord({
        type: "HKQuantityTypeIdentifierRestingHeartRate",
        value: 54,
        startDate: new Date("2024-03-01T07:00:00Z"),
      }),
    ];

    const count = await upsertDailyMetricsBatch(db, "p1", records);
    expect(count).toBe(0);
    expect(capture.values).toHaveLength(0);
  });

  it("converts walking distance from meters to km", async () => {
    const { db, capture } = createMockDb();
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierDistanceWalkingRunning",
        value: 5200,
        startDate: new Date("2024-03-01T14:00:00Z"),
      }),
    ];

    await upsertDailyMetricsBatch(db, "p1", records);
    expect(capture.values[0]?.[0]).toMatchObject({ distanceKm: 5.2 });
  });

  it("rounds flights climbed to integer", async () => {
    const { db, capture } = createMockDb();
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierFlightsClimbed",
        value: 3.7,
        startDate: new Date("2024-03-01T14:00:00Z"),
      }),
    ];

    await upsertDailyMetricsBatch(db, "p1", records);
    expect(capture.values[0]?.[0]).toMatchObject({ flightsClimbed: 4 });
  });

  it("rounds exercise minutes", async () => {
    const { db, capture } = createMockDb();
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierAppleExerciseTime",
        value: 45.7,
        startDate: new Date("2024-03-01T00:00:00Z"),
      }),
    ];

    await upsertDailyMetricsBatch(db, "p1", records);
    expect(capture.values[0]?.[0]).toMatchObject({ exerciseMinutes: 46 });
  });

  it("converts stand time from minutes to hours", async () => {
    const { db, capture } = createMockDb();
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierAppleStandTime",
        value: 720,
        startDate: new Date("2024-03-01T00:00:00Z"),
      }),
    ];

    await upsertDailyMetricsBatch(db, "p1", records);
    expect(capture.values[0]?.[0]).toMatchObject({ standHours: 12 });
  });

  it("maps HRV", async () => {
    const { db, capture } = createMockDb();
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
        value: 45.2,
        startDate: new Date("2024-03-01T06:00:00Z"),
      }),
    ];

    await upsertDailyMetricsBatch(db, "p1", records);
    expect(capture.values[0]?.[0]).toMatchObject({ hrv: 45.2 });
  });

  it("ignores provider VO2 Max as a daily metric", async () => {
    const { db, capture } = createMockDb();
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierVO2Max",
        value: 48.5,
        startDate: new Date("2024-03-01T10:00:00Z"),
      }),
    ];

    const count = await upsertDailyMetricsBatch(db, "p1", records);
    expect(count).toBe(0);
    expect(capture.values).toHaveLength(0);
  });

  it("maps walking speed", async () => {
    const { db, capture } = createMockDb();
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierWalkingSpeed",
        value: 1.4,
        startDate: new Date("2024-03-01T14:00:00Z"),
      }),
    ];

    await upsertDailyMetricsBatch(db, "p1", records);
    expect(capture.values[0]?.[0]).toMatchObject({ walkingSpeed: 1.4 });
  });

  it("maps walking step length", async () => {
    const { db, capture } = createMockDb();
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierWalkingStepLength",
        value: 0.72,
        startDate: new Date("2024-03-01T14:00:00Z"),
      }),
    ];

    await upsertDailyMetricsBatch(db, "p1", records);
    expect(capture.values[0]?.[0]).toMatchObject({ walkingStepLength: 0.72 });
  });

  it("maps walking double support percentage", async () => {
    const { db, capture } = createMockDb();
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierWalkingDoubleSupportPercentage",
        value: 0.28,
        startDate: new Date("2024-03-01T14:00:00Z"),
      }),
    ];

    await upsertDailyMetricsBatch(db, "p1", records);
    expect(capture.values[0]?.[0]).toMatchObject({ walkingDoubleSupportPct: 0.28 });
  });

  it("maps walking asymmetry percentage", async () => {
    const { db, capture } = createMockDb();
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierWalkingAsymmetryPercentage",
        value: 0.05,
        startDate: new Date("2024-03-01T14:00:00Z"),
      }),
    ];

    await upsertDailyMetricsBatch(db, "p1", records);
    expect(capture.values[0]?.[0]).toMatchObject({ walkingAsymmetryPct: 0.05 });
  });

  it("maps walking steadiness", async () => {
    const { db, capture } = createMockDb();
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierAppleWalkingSteadiness",
        value: 0.95,
        startDate: new Date("2024-03-01T14:00:00Z"),
      }),
    ];

    await upsertDailyMetricsBatch(db, "p1", records);
    expect(capture.values[0]?.[0]).toMatchObject({ walkingSteadiness: 0.95 });
  });

  it("does not use walking HR average as fallback for resting HR", async () => {
    const { db, capture } = createMockDb();
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierWalkingHeartRateAverage",
        value: 105.4,
        startDate: new Date("2024-03-01T14:00:00Z"),
      }),
    ];

    const count = await upsertDailyMetricsBatch(db, "p1", records);
    expect(count).toBe(1);
    expect(capture.values).toHaveLength(1);
    expect(capture.values[0]).toHaveLength(1);
    expect(Object.hasOwn(capture.values[0]?.[0] ?? {}, "restingHr")).toBe(false);
  });

  it("does not use resting HR or walking HR average as daily resting HR", async () => {
    const { db, capture } = createMockDb();
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierRestingHeartRate",
        value: 52,
        startDate: new Date("2024-03-01T06:00:00Z"),
      }),
      makeRecord({
        type: "HKQuantityTypeIdentifierWalkingHeartRateAverage",
        value: 105,
        startDate: new Date("2024-03-01T14:00:00Z"),
      }),
    ];

    const count = await upsertDailyMetricsBatch(db, "p1", records);
    expect(count).toBe(1);
    expect(capture.values).toHaveLength(1);
    expect(capture.values[0]).toHaveLength(1);
    expect(Object.hasOwn(capture.values[0]?.[0] ?? {}, "restingHr")).toBe(false);
  });

  it("separates records across different days", async () => {
    const { db } = createMockDb();
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierStepCount",
        value: 5000,
        startDate: new Date("2024-03-01T14:00:00Z"),
      }),
      makeRecord({
        type: "HKQuantityTypeIdentifierStepCount",
        value: 7000,
        startDate: new Date("2024-03-02T14:00:00Z"),
      }),
    ];

    const count = await upsertDailyMetricsBatch(db, "p1", records);
    expect(count).toBe(2);
  });

  it("skips non-daily record types", async () => {
    const { db } = createMockDb();
    const records = [makeRecord({ type: "HKQuantityTypeIdentifierHeartRate", value: 72 })];

    const count = await upsertDailyMetricsBatch(db, "p1", records);
    expect(count).toBe(0);
  });

  it("maps push count as additive integer", async () => {
    const { db, capture } = createMockDb();
    const records = [
      makeRecord({ type: "HKQuantityTypeIdentifierPushCount", value: 50 }),
      makeRecord({ type: "HKQuantityTypeIdentifierPushCount", value: 30 }),
    ];

    await upsertDailyMetricsBatch(db, "p1", records);
    expect(capture.values[0]?.[0]).toMatchObject({ pushCount: 80 });
  });

  it("maps wheelchair distance to km", async () => {
    const { db, capture } = createMockDb();
    const records = [
      makeRecord({ type: "HKQuantityTypeIdentifierDistanceWheelchair", value: 5000 }),
    ];

    await upsertDailyMetricsBatch(db, "p1", records);
    expect(capture.values[0]?.[0]).toMatchObject({ wheelchairDistanceKm: 5 });
  });

  it("maps UV exposure as point-in-time value", async () => {
    const { db, capture } = createMockDb();
    const records = [makeRecord({ type: "HKQuantityTypeIdentifierUVExposure", value: 6.5 })];

    await upsertDailyMetricsBatch(db, "p1", records);
    expect(capture.values[0]?.[0]).toMatchObject({ uvExposure: 6.5 });
  });
});

// ---------------------------------------------------------------------------
// upsertNutritionBatch
// ---------------------------------------------------------------------------

describe("upsertNutritionBatch", () => {
  function createNutritionMockDb(): ReturnType<typeof createMockDb> {
    return createMockDb([{ id: "food-entry-1" }]);
  }

  function capturedNutritionRows(capture: MockInsertCapture): Record<string, unknown>[] {
    return capture.values.filter((_, index) => index % 2 === 1).flat();
  }

  it("uses the source calendar day for nutrition instead of UTC-shifted date", async () => {
    const { db, capture } = createNutritionMockDb();
    const parsedRecord = parseRecord({
      type: "HKQuantityTypeIdentifierDietaryEnergyConsumed",
      value: "500",
      sourceName: "Apple Watch",
      unit: "kcal",
      // Local day is March 1, but UTC day is March 2.
      startDate: "2024-03-01 23:45:00 -0800",
      endDate: "2024-03-01 23:45:10 -0800",
      creationDate: "2024-03-01 23:46:00 -0800",
    });
    expect(parsedRecord).not.toBeNull();
    if (!parsedRecord) return;

    await upsertNutritionBatch(db, "apple_health", [parsedRecord]);

    expect(capture.values[0]?.[0]).toMatchObject({
      date: "2024-03-01",
      foodName: null,
      sourceName: "Apple Watch",
    });
    expect(capture.values[1]?.[0]).toMatchObject({ nutrientId: "calories", amount: 500 });
  });

  it("stores Apple Health nutrition as unnamed food entry nutrition rows", async () => {
    const { db, capture } = createNutritionMockDb();
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierDietaryProtein",
        value: 45.5,
        unit: "g",
        sourceName: "Cronometer",
        startDate: new Date("2024-03-01T20:00:00Z"),
        endDate: new Date("2024-03-01T20:00:10Z"),
      }),
    ];

    const count = await upsertNutritionBatch(db, "apple_health", records);

    expect(count).toBe(1);
    expect(capture.values[0]?.[0]).toMatchObject({
      providerId: "apple_health",
      externalId:
        "ah:nutrition:HKQuantityTypeIdentifierDietaryProtein:Cronometer:2024-03-01T20:00:00.000Z:2024-03-01T20:00:10.000Z",
      date: "2024-03-01",
      foodName: null,
      sourceName: "Cronometer",
      loggedAt: records[0]?.creationDate,
      startedAt: records[0]?.startDate,
      endedAt: records[0]?.endDate,
      confirmed: true,
    });
    expect(capture.values[1]?.[0]).toMatchObject({
      foodEntryId: "food-entry-1",
      nutrientId: "protein",
      amount: 45.5,
    });
  });

  it("stores calorie samples separately for derived daily aggregation", async () => {
    const { db, capture } = createNutritionMockDb();
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierDietaryEnergyConsumed",
        value: 650,
        startDate: new Date("2024-03-01T12:00:00Z"),
      }),
      makeRecord({
        type: "HKQuantityTypeIdentifierDietaryEnergyConsumed",
        value: 800,
        startDate: new Date("2024-03-01T18:00:00Z"),
      }),
    ];

    const count = await upsertNutritionBatch(db, "p1", records);
    expect(count).toBe(2);
    expect(capture.values[0]?.[0]).toMatchObject({ date: "2024-03-01" });
    expect(capture.values[2]?.[0]).toMatchObject({ date: "2024-03-01" });
    expect(capturedNutritionRows(capture)).toEqual([
      expect.objectContaining({ nutrientId: "calories", amount: 650 }),
      expect.objectContaining({ nutrientId: "calories", amount: 800 }),
    ]);
  });

  it("maps protein", async () => {
    const { db, capture } = createNutritionMockDb();
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierDietaryProtein",
        value: 45.5,
        startDate: new Date("2024-03-01T20:00:00Z"),
      }),
    ];

    await upsertNutritionBatch(db, "p1", records);
    expect(findCapturedNutrient(capture, "protein")?.amount).toBe(45.5);
  });

  it("maps carbs", async () => {
    const { db, capture } = createNutritionMockDb();
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierDietaryCarbohydrates",
        value: 200,
        startDate: new Date("2024-03-01T12:00:00Z"),
      }),
    ];

    await upsertNutritionBatch(db, "p1", records);
    expect(findCapturedNutrient(capture, "carbohydrate")?.amount).toBe(200);
  });

  it("maps fat", async () => {
    const { db, capture } = createNutritionMockDb();
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierDietaryFatTotal",
        value: 70,
        startDate: new Date("2024-03-01T12:00:00Z"),
      }),
    ];

    await upsertNutritionBatch(db, "p1", records);
    expect(findCapturedNutrient(capture, "fat")?.amount).toBe(70);
  });

  it("maps fiber", async () => {
    const { db, capture } = createNutritionMockDb();
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierDietaryFiber",
        value: 25,
        startDate: new Date("2024-03-01T12:00:00Z"),
      }),
    ];

    await upsertNutritionBatch(db, "p1", records);
    expect(findCapturedNutrient(capture, "fiber")?.amount).toBe(25);
  });

  it("maps water and rounds", async () => {
    const { db, capture } = createNutritionMockDb();
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierDietaryWater",
        value: 2500.7,
        startDate: new Date("2024-03-01T12:00:00Z"),
      }),
    ];

    await upsertNutritionBatch(db, "p1", records);
    expect(capturedNutritionRows(capture)[0]).toMatchObject({ nutrientId: "water", amount: 2501 });
  });

  it("skips non-nutrition record types", async () => {
    const { db } = createMockDb();
    const records = [makeRecord({ type: "HKQuantityTypeIdentifierHeartRate", value: 72 })];

    const count = await upsertNutritionBatch(db, "p1", records);
    expect(count).toBe(0);
  });

  it("maps dietary sodium", async () => {
    const { db, capture } = createNutritionMockDb();
    const records = [makeRecord({ type: "HKQuantityTypeIdentifierDietarySodium", value: 1500 })];

    await upsertNutritionBatch(db, "p1", records);
    expect(findCapturedNutrient(capture, "sodium")?.amount).toBe(1500);
  });

  it("maps dietary sugar", async () => {
    const { db, capture } = createNutritionMockDb();
    const records = [makeRecord({ type: "HKQuantityTypeIdentifierDietarySugar", value: 30 })];

    await upsertNutritionBatch(db, "p1", records);
    expect(findCapturedNutrient(capture, "sugar")?.amount).toBe(30);
  });

  it("maps dietary cholesterol", async () => {
    const { db, capture } = createNutritionMockDb();
    const records = [
      makeRecord({ type: "HKQuantityTypeIdentifierDietaryCholesterol", value: 200 }),
    ];

    await upsertNutritionBatch(db, "p1", records);
    expect(findCapturedNutrient(capture, "cholesterol")?.amount).toBe(200);
  });

  it("maps dietary saturated fat", async () => {
    const { db, capture } = createNutritionMockDb();
    const records = [
      makeRecord({ type: "HKQuantityTypeIdentifierDietaryFatSaturated", value: 15 }),
    ];

    await upsertNutritionBatch(db, "p1", records);
    expect(findCapturedNutrient(capture, "saturated_fat")?.amount).toBe(15);
  });

  it("maps dietary potassium", async () => {
    const { db, capture } = createNutritionMockDb();
    const records = [makeRecord({ type: "HKQuantityTypeIdentifierDietaryPotassium", value: 3500 })];

    await upsertNutritionBatch(db, "p1", records);
    expect(findCapturedNutrient(capture, "potassium")?.amount).toBe(3500);
  });

  it("maps dietary vitamins and minerals", async () => {
    const { db, capture } = createNutritionMockDb();
    const records = [
      makeRecord({ type: "HKQuantityTypeIdentifierDietaryVitaminA", value: 900 }),
      makeRecord({ type: "HKQuantityTypeIdentifierDietaryVitaminC", value: 90 }),
      makeRecord({ type: "HKQuantityTypeIdentifierDietaryVitaminD", value: 20 }),
      makeRecord({ type: "HKQuantityTypeIdentifierDietaryCalcium", value: 1000 }),
      makeRecord({ type: "HKQuantityTypeIdentifierDietaryIron", value: 18 }),
      makeRecord({ type: "HKQuantityTypeIdentifierDietaryMagnesium", value: 400 }),
      makeRecord({ type: "HKQuantityTypeIdentifierDietaryZinc", value: 11 }),
    ];

    await upsertNutritionBatch(db, "p1", records);
    expect(findCapturedNutrient(capture, "vitamin_a")?.amount).toBe(900);
    expect(findCapturedNutrient(capture, "vitamin_c")?.amount).toBe(90);
    expect(findCapturedNutrient(capture, "vitamin_d")?.amount).toBe(20);
    expect(findCapturedNutrient(capture, "calcium")?.amount).toBe(1000);
    expect(findCapturedNutrient(capture, "iron")?.amount).toBe(18);
    expect(findCapturedNutrient(capture, "magnesium")?.amount).toBe(400);
    expect(findCapturedNutrient(capture, "zinc")?.amount).toBe(11);
  });
});

// ---------------------------------------------------------------------------
// upsertHealthEventBatch
// ---------------------------------------------------------------------------

describe("upsertHealthEventBatch", () => {
  it("stores unrouted record types", async () => {
    const { db, capture } = createMockDb();
    const date = new Date("2024-03-01T12:00:00Z");
    const records = [
      makeRecord({
        type: "SomeUnroutedType",
        value: 42,
        unit: "count",
        sourceName: "MyApp",
        startDate: date,
        endDate: date,
      }),
    ];

    const count = await upsertHealthEventBatch(db, "p1", records);
    expect(count).toBe(1);
    expect(capture.values[0]?.[0]).toMatchObject({
      providerId: "p1",
      type: "SomeUnroutedType",
      value: 42,
      unit: "count",
      sourceName: "MyApp",
      externalId: `ah:SomeUnroutedType:${date.toISOString()}`,
    });
  });

  it("skips already-routed types", async () => {
    const { db } = createMockDb();
    const records = [
      makeRecord({ type: "HKQuantityTypeIdentifierHeartRate", value: 72 }),
      makeRecord({ type: "HKQuantityTypeIdentifierStepCount", value: 1000 }),
      makeRecord({ type: "HKQuantityTypeIdentifierBodyMass", value: 72 }),
    ];

    const count = await upsertHealthEventBatch(db, "p1", records);
    expect(count).toBe(0);
  });

  it("does not insert when all records are routed types", async () => {
    const { db, capture } = createMockDb();
    const records = [makeRecord({ type: "HKQuantityTypeIdentifierHeartRate", value: 72 })];

    await upsertHealthEventBatch(db, "p1", records);
    expect(capture.values).toHaveLength(0);
  });

  it("ignores provider resting HR and VO2 Max health events", async () => {
    const { db, capture } = createMockDb();
    const date = new Date("2024-03-02T06:00:00Z");
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierRestingHeartRate",
        value: 51,
        unit: "count/min",
        startDate: date,
        endDate: date,
      }),
      makeRecord({
        type: "HKQuantityTypeIdentifierVO2Max",
        value: 47.2,
        unit: "mL/min/kg",
        startDate: date,
        endDate: date,
      }),
    ];

    const count = await upsertHealthEventBatch(db, "p1", records);

    expect(count).toBe(0);
    expect(capture.values).toHaveLength(0);
  });

  it("batches in groups of 5000", async () => {
    const { db, capture } = createMockDb();
    const records: HealthRecord[] = [];
    for (let i = 0; i < 6000; i++) {
      records.push(
        makeRecord({
          type: "SomeUnroutedType",
          value: i,
          startDate: new Date(Date.UTC(2024, 0, 1, 0, 0, i)),
        }),
      );
    }

    await upsertHealthEventBatch(db, "p1", records);
    expect(capture.values).toHaveLength(2);
    expect(capture.values[0]).toHaveLength(5000);
    expect(capture.values[1]).toHaveLength(1000);
  });
});

// ---------------------------------------------------------------------------
// upsertWorkoutBatch
// ---------------------------------------------------------------------------

describe("upsertWorkoutBatch", () => {
  it("deduplicates workouts with the same startDate", async () => {
    const sharedStart = new Date("2024-06-01T08:00:00Z");
    const { db } = createMockDb([{ id: "10000000-0000-4000-8000-000000000001" }]);

    const workouts = [
      makeWorkout({ startDate: sharedStart, sourceName: "Apple Watch" }),
      makeWorkout({ startDate: sharedStart, sourceName: "iPhone" }),
    ];

    const count = await upsertWorkoutBatch(db, "p1", workouts);
    expect(count).toBe(1);
  });

  it("preserves unique workouts while deduplicating", async () => {
    const { db } = createMockDb([
      { id: "10000000-0000-4000-8000-000000000001" },
      { id: "10000000-0000-4000-8000-000000000002" },
    ]);

    const workouts = [
      makeWorkout({ startDate: new Date("2024-06-01T08:00:00Z") }),
      makeWorkout({ startDate: new Date("2024-06-01T08:00:00Z"), sourceName: "iPhone" }),
      makeWorkout({
        startDate: new Date("2024-06-01T10:00:00Z"),
        activityType: resolveProviderActivityType("HKWorkoutActivityTypeCycling", "cycling"),
      }),
    ];

    const count = await upsertWorkoutBatch(db, "p1", workouts);
    expect(count).toBe(2);
  });

  it("builds correct insert row fields", async () => {
    const start = new Date("2024-06-01T08:00:00Z");
    const end = new Date("2024-06-01T08:30:00Z");
    const { db } = createMockDb([{ id: "10000000-0000-4000-8000-000000000001" }]);

    await upsertWorkoutBatch(db, "p1", [
      makeWorkout({
        startDate: start,
        endDate: end,
        activityType: resolveProviderActivityType("HKWorkoutActivityTypeCycling", "cycling"),
        sourceName: "Wahoo",
      }),
    ]);

    expect(
      findActivityUpsertValues((row) => row.externalId === `ah:workout:${start.toISOString()}`),
    ).toMatchObject({
      providerId: "p1",
      externalId: `ah:workout:${start.toISOString()}`,
      activityType: {
        canonicalType: "cycling",
        providerType: "HKWorkoutActivityTypeCycling",
        modality: null,
      },
      startedAt: start,
      endedAt: end,
      sourceName: "Wahoo",
    });
  });

  it("uses Hang Ten session metadata for hangboard activity rows", async () => {
    const start = new Date("2026-08-07T14:00:00Z");
    const { db } = createMockDb([{ id: "10000000-0000-4000-8000-000000000001" }]);

    await upsertWorkoutBatch(db, "apple_health", [
      makeWorkout({
        activityType: resolveProviderActivityType("Hang Ten", "hangboard"),
        sourceName: "Hang Ten",
        startDate: start,
        hangTen: {
          sessionId: "11111111-1111-4111-8111-111111111111",
          planName: "7/3 Repeaters",
          boardId: "metolius-compact-ii",
          boardName: "Metolius Compact II",
          rawActivitySegments: '{"segments":[],"version":1}',
          activitySegments: [],
        },
      }),
    ]);

    expect(
      findActivityUpsertValues(
        (row) => row.externalId === "ah:workout:11111111-1111-4111-8111-111111111111",
      ),
    ).toMatchObject({
      providerId: "apple_health",
      externalId: "ah:workout:11111111-1111-4111-8111-111111111111",
      activityType: {
        canonicalType: "hangboard",
        providerType: "Hang Ten",
        modality: null,
      },
      name: "7/3 Repeaters",
      sourceName: "Hang Ten",
      raw: {
        durationSeconds: 1800,
        hangTen: {
          sessionId: "11111111-1111-4111-8111-111111111111",
          planName: "7/3 Repeaters",
          boardId: "metolius-compact-ii",
          boardName: "Metolius Compact II",
          rawActivitySegments: '{"segments":[],"version":1}',
          activitySegments: [],
        },
      },
    });
  });

  it("updates the activity name from a reimported Hang Ten plan", async () => {
    const { db } = createMockDb([{ id: "10000000-0000-4000-8000-000000000001" }]);

    await upsertWorkoutBatch(db, "apple_health", [
      makeWorkout({
        activityType: resolveProviderActivityType("Hang Ten", "hangboard"),
        sourceName: "Hang Ten",
        hangTen: { planName: "Updated Repeaters" },
      }),
    ]);

    const update = providerActivityAbsenceMocks.upsertProviderActivity.mock.calls[0]?.[2];
    expect(isRecord(update) ? update.name : undefined).toBeDefined();
  });

  it("preserves a Hang Ten segment parse error without inserting intervals", async () => {
    const { db, capture } = createMockDb([{ id: "10000000-0000-4000-8000-000000000001" }]);

    await upsertWorkoutBatch(db, "apple_health", [
      makeWorkout({
        activityType: resolveProviderActivityType("Hang Ten", "hangboard"),
        sourceName: "Hang Ten",
        hangTen: {
          planName: "Repeaters",
          rawActivitySegments: "{not-json}",
          activitySegmentsError: "Unexpected token n in JSON at position 1",
        },
      }),
    ]);

    expect(capture.executions).toHaveLength(0);
    expect(findActivityUpsertValues(() => true)).toMatchObject({
      raw: {
        hangTen: {
          rawActivitySegments: "{not-json}",
          activitySegmentsError: "Unexpected token n in JSON at position 1",
        },
      },
    });
  });

  it("uses returned activity IDs for Hang Ten interval replacement", async () => {
    const firstStart = new Date("2026-08-07T14:00:00Z");
    const secondStart = new Date("2026-08-07T15:00:00Z");
    const firstActivityId = "10000000-0000-4000-8000-000000000001";
    const secondActivityId = "10000000-0000-4000-8000-000000000002";
    const { db, capture } = createMockDb([{ id: firstActivityId }, { id: secondActivityId }]);

    await upsertWorkoutBatch(db, "apple_health", [
      makeWorkout({
        activityType: resolveProviderActivityType("Hang Ten", "hangboard"),
        sourceName: "Hang Ten",
        startDate: firstStart,
        hangTen: {
          sessionId: "session-first",
          planName: "First Plan",
          activitySegments: [
            {
              stepID: "first-step",
              stepNumber: 1,
              kind: "work",
              holdIDs: [],
              holdType: "first-hold",
              durationSeconds: 7,
            },
          ],
        },
        routeLocations: [{ date: firstStart, lat: 11, lng: 12 }],
      }),
      makeWorkout({
        activityType: resolveProviderActivityType("Hang Ten", "hangboard"),
        sourceName: "Hang Ten",
        startDate: secondStart,
        hangTen: {
          sessionId: "session-second",
          planName: "Second Plan",
          activitySegments: [
            {
              stepID: "second-step",
              stepNumber: 2,
              kind: "work",
              holdIDs: [],
              holdType: "second-hold",
              durationSeconds: 8,
            },
          ],
        },
        routeLocations: [{ date: secondStart, lat: 21, lng: 22 }],
      }),
    ]);

    const intervalReplacements = capture.executions.filter((execution) =>
      execution.sql.includes("activity_interval"),
    );
    expect(intervalReplacements).toHaveLength(2);
    expect(intervalReplacements[0]?.sql).toMatch(
      /INSERT INTO "fitness"\."activity_interval" \(activity_id, interval_index, label, interval_type, started_at, ended_at\)/,
    );
    expect(intervalReplacements.map((replacement) => replacement.params)).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([firstActivityId, "Step 1: first-hold"]),
        expect.arrayContaining([secondActivityId, "Step 2: second-hold"]),
      ]),
    );
  });

  it("inserts GPS route locations for workouts", async () => {
    const activityId = "10000000-0000-4000-8000-000000000001";
    const { db, capture } = createMockDb([{ id: activityId }]);
    const location = {
      date: new Date("2024-06-01T08:00:00Z"),
      lat: 40.7128,
      lng: -74.006,
      altitude: 10.5,
      speed: 3.5,
      horizontalAccuracy: 5.2,
    };

    await runWithTokenUser("00000000-0000-0000-0000-000000000001", () =>
      upsertWorkoutBatch(db, "p1", [makeWorkout({ routeLocations: [location] })]),
    );

    // Activity upsert goes through upsertProviderActivity; capture only has metric_stream rows.
    expect(capture.values).toHaveLength(1);
    expect(capture.values[0]).toContainEqual(
      expect.objectContaining({
        providerId: "p1",
        activityId,
        channel: "location",
        point: "SRID=4326;POINT(-74.006 40.7128)",
        metadata: { horizontal_accuracy_m: 5.2 },
      }),
    );
    expect(capture.values[0]).toContainEqual(
      expect.objectContaining({
        providerId: "p1",
        activityId,
        channel: "altitude",
        scalar: 10.5,
      }),
    );
    expect(capture.values[0]).toContainEqual(
      expect.objectContaining({
        providerId: "p1",
        activityId,
        channel: "speed",
        scalar: 3.5,
      }),
    );
  });

  it("skips GPS insert when no route locations", async () => {
    const { db, capture } = createMockDb([{ id: "10000000-0000-4000-8000-000000000001" }]);

    await upsertWorkoutBatch(db, "p1", [makeWorkout({ routeLocations: [] })]);

    expect(capture.values).toHaveLength(0);
  });

  it("handles undefined horizontalAccuracy in GPS", async () => {
    const { db, capture } = createMockDb([{ id: "10000000-0000-4000-8000-000000000001" }]);
    const loc = {
      date: new Date("2024-06-01T08:00:00Z"),
      lat: 40.7128,
      lng: -74.006,
    };

    await runWithTokenUser("00000000-0000-0000-0000-000000000001", () =>
      upsertWorkoutBatch(db, "p1", [makeWorkout({ routeLocations: [loc] })]),
    );

    const locationRow = capture.values[0]?.find((row) => row.channel === "location");
    expect(locationRow?.metadata).toBeNull();
  });

  it("populates raw JSONB with workout metrics", async () => {
    const { db } = createMockDb([{ id: "10000000-0000-4000-8000-000000000001" }]);

    await upsertWorkoutBatch(db, "p1", [
      makeWorkout({
        distanceMeters: 5200,
        avgHeartRate: 148,
        maxHeartRate: 182,
        durationSeconds: 1830,
      }),
    ]);

    expect(findActivityUpsertValues(() => true)?.raw).toMatchObject({
      distanceMeters: 5200,
      avgHeartRate: 148,
      maxHeartRate: 182,
      durationSeconds: 1830,
    });
  });

  it("omits undefined optional fields from raw JSONB", async () => {
    const { db } = createMockDb([{ id: "10000000-0000-4000-8000-000000000001" }]);

    await upsertWorkoutBatch(db, "p1", [makeWorkout()]);

    const raw = findActivityUpsertValues(() => true)?.raw;
    expect(raw).toMatchObject({ durationSeconds: 1800 });
    expect(raw).not.toHaveProperty("distanceMeters");
    expect(raw).not.toHaveProperty("avgHeartRate");
    expect(raw).not.toHaveProperty("maxHeartRate");
  });

  it("does not update existing heart-rate metric_stream rows after workout insert", async () => {
    const { db } = createMockDb([{ id: "10000000-0000-4000-8000-000000000001" }]);

    await upsertWorkoutBatch(db, "p1", [makeWorkout()]);

    expect(db.execute).not.toHaveBeenCalled();
  });

  it("does not call execute for empty workouts array", async () => {
    const { db } = createMockDb();
    await upsertWorkoutBatch(db, "p1", []);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("returns 0 for empty workouts array", async () => {
    const { db } = createMockDb();
    const count = await upsertWorkoutBatch(db, "p1", []);
    expect(count).toBe(0);
  });

  it("publishes route locations with the replacement scope partition key", async () => {
    const activityId = "10000000-0000-4000-8000-000000000001";
    const { db, capture } = createMockDb([{ id: activityId }]);
    const recordedAtStart = new Date("2024-01-01T00:00:00Z");
    const location = {
      date: new Date("2024-06-01T08:00:00Z"),
      lat: 40.7128,
      lng: -74.006,
    };

    await runWithTokenUser("00000000-0000-0000-0000-000000000001", () =>
      upsertWorkoutBatch(db, "p1", [makeWorkout({ routeLocations: [location] })], {
        userId: "00000000-0000-0000-0000-000000000001",
        providerId: "p1",
        recordedAtStart,
      }),
    );

    expect(capture.partitionKeys).toContain(expectedProviderPartitionKey("p1", recordedAtStart));
    expect(capture.values.flat()).toContainEqual(
      expect.objectContaining({
        providerId: "p1",
        activityId,
        channel: "location",
        point: "SRID=4326;POINT(-74.006 40.7128)",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// upsertSleepBatch
// ---------------------------------------------------------------------------

describe("upsertSleepBatch", () => {
  it("deduplicates inBed records with the same startDate", async () => {
    const { db } = createMockDb();
    const bedStart = new Date("2024-06-15T23:00:00Z");

    const records = [
      makeSleep({ startDate: bedStart, sourceName: "Apple Watch" }),
      makeSleep({ startDate: bedStart, sourceName: "iPhone" }),
    ];

    const count = await upsertSleepBatch(db, "p1", records);
    expect(count).toBe(1);
  });

  it("preserves unique sleep sessions while deduplicating", async () => {
    const { db } = createMockDb();
    const records = [
      makeSleep({ startDate: new Date("2024-06-15T23:00:00Z") }),
      makeSleep({ startDate: new Date("2024-06-15T23:00:00Z"), sourceName: "iPhone" }),
      makeSleep({ startDate: new Date("2024-06-16T23:00:00Z") }),
    ];

    const count = await upsertSleepBatch(db, "p1", records);
    expect(count).toBe(2);
  });

  it("aggregates sleep stage durations within a session", async () => {
    const { db, capture } = createMockDb();
    const bedStart = new Date("2024-03-01T23:00:00Z");
    const bedEnd = new Date("2024-03-02T07:00:00Z");

    const records: SleepAnalysisRecord[] = [
      makeSleep({ startDate: bedStart, endDate: bedEnd, durationMinutes: 480 }),
      makeSleep({
        stage: "deep",
        startDate: new Date("2024-03-02T00:00:00Z"),
        endDate: new Date("2024-03-02T01:30:00Z"),
        durationMinutes: 90,
      }),
      makeSleep({
        stage: "rem",
        startDate: new Date("2024-03-02T01:30:00Z"),
        endDate: new Date("2024-03-02T03:00:00Z"),
        durationMinutes: 90,
      }),
      makeSleep({
        stage: "core",
        startDate: new Date("2024-03-02T03:00:00Z"),
        endDate: new Date("2024-03-02T05:00:00Z"),
        durationMinutes: 120,
      }),
      makeSleep({
        stage: "awake",
        startDate: new Date("2024-03-02T05:00:00Z"),
        endDate: new Date("2024-03-02T05:15:00Z"),
        durationMinutes: 15,
      }),
    ];

    await upsertSleepBatch(db, "p1", records);
    expect(capture.values[0]?.[0]).toMatchObject({
      deepMinutes: 90,
      remMinutes: 90,
      lightMinutes: 120,
      awakeMinutes: 15,
      stagingAvailable: true,
    });
  });

  it("does not store efficiencyPct (derived in v_sleep view)", async () => {
    const { db, capture } = createMockDb();
    const bedStart = new Date("2024-03-01T23:00:00Z");
    const bedEnd = new Date("2024-03-02T07:00:00Z");

    const records: SleepAnalysisRecord[] = [
      makeSleep({ startDate: bedStart, endDate: bedEnd, durationMinutes: 480 }),
      makeSleep({
        stage: "deep",
        startDate: new Date("2024-03-02T00:00:00Z"),
        endDate: new Date("2024-03-02T02:00:00Z"),
        durationMinutes: 120,
      }),
      makeSleep({
        stage: "core",
        startDate: new Date("2024-03-02T02:00:00Z"),
        endDate: new Date("2024-03-02T06:00:00Z"),
        durationMinutes: 240,
      }),
    ];

    await upsertSleepBatch(db, "p1", records);
    expect(capture.values[0]?.[0]).not.toHaveProperty("efficiencyPct");
  });

  it("stores null sleep_type for short sessions", async () => {
    const { db, capture } = createMockDb();
    const records = [makeSleep({ durationMinutes: 60 })];

    await upsertSleepBatch(db, "p1", records);
    expect(capture.values[0]?.[0]).toMatchObject({ sleepType: null });
  });

  it("stores null sleep_type for long sessions", async () => {
    const { db, capture } = createMockDb();
    const records = [makeSleep({ durationMinutes: 480 })];

    await upsertSleepBatch(db, "p1", records);
    expect(capture.values[0]?.[0]).toMatchObject({ sleepType: null });
  });

  it("generates correct externalId", async () => {
    const { db, capture } = createMockDb();
    const bedStart = new Date("2024-06-15T23:00:00Z");
    const records = [makeSleep({ startDate: bedStart })];

    await upsertSleepBatch(db, "p1", records);
    expect(capture.values[0]?.[0]).toMatchObject({
      externalId: `ah:sleep:${bedStart.toISOString()}`,
    });
  });

  it("stores null stage values and marks staging unavailable when no stages were reported", async () => {
    const { db, capture } = createMockDb();
    const records = [makeSleep()];

    await upsertSleepBatch(db, "p1", records);
    expect(capture.values[0]?.[0]).toMatchObject({
      deepMinutes: null,
      remMinutes: null,
      lightMinutes: null,
      awakeMinutes: null,
      stagingAvailable: false,
    });
  });

  it.each([
    "deep",
    "rem",
    "core",
  ] as const)("marks staging available when Apple Health reports a %s stage", async (stage) => {
    const { db, capture } = createMockDb();
    const bedStart = new Date("2024-03-01T23:00:00Z");
    const bedEnd = new Date("2024-03-02T07:00:00Z");

    await upsertSleepBatch(db, "p1", [
      makeSleep({ startDate: bedStart, endDate: bedEnd }),
      makeSleep({
        stage,
        startDate: new Date("2024-03-02T00:00:00Z"),
        endDate: new Date("2024-03-02T01:00:00Z"),
        durationMinutes: 60,
      }),
    ]);

    expect(capture.values[0]?.[0]).toMatchObject({
      awakeMinutes: 0,
      stagingAvailable: true,
    });
  });

  it("preserves an awake-only measurement without claiming a stage bundle", async () => {
    const { db, capture } = createMockDb();
    const bedStart = new Date("2024-03-01T23:00:00Z");
    const bedEnd = new Date("2024-03-02T07:00:00Z");

    await upsertSleepBatch(db, "p1", [
      makeSleep({ startDate: bedStart, endDate: bedEnd }),
      makeSleep({
        stage: "awake",
        startDate: new Date("2024-03-02T00:00:00Z"),
        endDate: new Date("2024-03-02T00:15:00Z"),
        durationMinutes: 15,
      }),
    ]);

    expect(capture.values[0]?.[0]).toMatchObject({
      deepMinutes: null,
      remMinutes: null,
      lightMinutes: null,
      awakeMinutes: 15,
      stagingAvailable: false,
    });
  });

  it("only includes stage records within the inBed time window", async () => {
    const { db, capture } = createMockDb();
    const bedStart = new Date("2024-03-01T23:00:00Z");
    const bedEnd = new Date("2024-03-02T07:00:00Z");

    const records: SleepAnalysisRecord[] = [
      makeSleep({ startDate: bedStart, endDate: bedEnd }),
      // Inside window
      makeSleep({
        stage: "deep",
        startDate: new Date("2024-03-02T00:00:00Z"),
        endDate: new Date("2024-03-02T01:00:00Z"),
        durationMinutes: 60,
      }),
      // Outside window (before bed start)
      makeSleep({
        stage: "deep",
        startDate: new Date("2024-03-01T22:00:00Z"),
        endDate: new Date("2024-03-01T22:30:00Z"),
        durationMinutes: 30,
      }),
      // Outside window (after bed end)
      makeSleep({
        stage: "rem",
        startDate: new Date("2024-03-02T07:30:00Z"),
        endDate: new Date("2024-03-02T08:00:00Z"),
        durationMinutes: 30,
      }),
    ];

    await upsertSleepBatch(db, "p1", records);
    // Only the 60min deep inside the window should be counted
    expect(capture.values[0]?.[0]).toMatchObject({ deepMinutes: 60, stagingAvailable: true });
    expect(capture.values[0]?.[0]).toHaveProperty("remMinutes", 0);
  });

  it("returns 0 for empty records", async () => {
    const { db } = createMockDb();
    const count = await upsertSleepBatch(db, "p1", []);
    expect(count).toBe(0);
  });

  it("returns 0 when no inBed records present", async () => {
    const { db } = createMockDb();
    const records = [makeSleep({ stage: "deep", durationMinutes: 60 })];

    const count = await upsertSleepBatch(db, "p1", records);
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Dedup: body measurements, daily metrics, nutrition
// Apple Health exports can contain duplicate records from multiple sources
// (Watch + iPhone) at the same timestamp. All onConflictDoUpdate operations
// must deduplicate within a batch to avoid PostgreSQL error:
// "ON CONFLICT DO UPDATE command cannot affect row a second time"
// ---------------------------------------------------------------------------

describe("upsertBodyMeasurementBatch — deduplication", () => {
  it("deduplicates body measurements at the same timestamp from different sources", async () => {
    const { db, capture } = createMockDb();
    const sharedTime = new Date("2024-06-01T08:00:00Z");

    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierBodyMass",
        sourceName: "Apple Watch",
        value: 80,
        unit: "kg",
        startDate: sharedTime,
        endDate: sharedTime,
      }),
      makeRecord({
        type: "HKQuantityTypeIdentifierBodyMass",
        sourceName: "iPhone",
        value: 80.1,
        unit: "kg",
        startDate: sharedTime,
        endDate: sharedTime,
      }),
    ];

    const count = await upsertBodyMeasurementBatch(db, "apple_health", records);
    // Should produce only 1 row (same timestamp → same externalId)
    expect(count).toBe(1);
    expect(capture.values).toHaveLength(1);
    expect(capture.values[0]).toHaveLength(1);
  });
});

describe("upsertDailyMetricsBatch — per-source rows", () => {
  it("stores separate rows per source for the same date", async () => {
    const { db, capture } = createMockDb();

    // Two step count records on the same day from different sources
    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierStepCount",
        sourceName: "Apple Watch",
        value: 5000,
        startDate: new Date("2024-06-01T10:00:00Z"),
        endDate: new Date("2024-06-01T10:30:00Z"),
      }),
      makeRecord({
        type: "HKQuantityTypeIdentifierStepCount",
        sourceName: "iPhone",
        value: 3000,
        startDate: new Date("2024-06-01T14:00:00Z"),
        endDate: new Date("2024-06-01T14:30:00Z"),
      }),
    ];

    const count = await upsertDailyMetricsBatch(db, "apple_health", records);
    // Different sources → separate rows (dedup happens at query time in the view)
    expect(count).toBe(2);
    expect(capture.values).toHaveLength(1);
    expect(capture.values[0]).toHaveLength(2);
    const sourceNames = capture.values[0]?.map((r: Record<string, unknown>) => r.sourceName).sort();
    expect(sourceNames).toEqual(["Apple Watch", "iPhone"]);
  });

  it("sums records from the same source on the same day", async () => {
    const { db, capture } = createMockDb();

    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierStepCount",
        sourceName: "Apple Watch",
        value: 2000,
        startDate: new Date("2024-06-01T10:00:00Z"),
        endDate: new Date("2024-06-01T10:30:00Z"),
      }),
      makeRecord({
        type: "HKQuantityTypeIdentifierStepCount",
        sourceName: "Apple Watch",
        value: 3000,
        startDate: new Date("2024-06-01T14:00:00Z"),
        endDate: new Date("2024-06-01T14:30:00Z"),
      }),
    ];

    const count = await upsertDailyMetricsBatch(db, "apple_health", records);
    // Same source → summed into one row
    expect(count).toBe(1);
    expect(capture.values[0]?.[0]).toMatchObject({ steps: 5000, sourceName: "Apple Watch" });
  });
});

describe("upsertDailyMetricsBatch — HRV averaging", () => {
  it("averages all HRV readings for the day", async () => {
    const { db, capture } = createMockDb();

    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
        value: 45, // overnight reading (first)
        startDate: new Date("2024-06-01T04:00:00Z"),
        endDate: new Date("2024-06-01T04:00:05Z"),
      }),
      makeRecord({
        type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
        value: 50, // morning reading
        startDate: new Date("2024-06-01T10:00:00Z"),
        endDate: new Date("2024-06-01T10:00:05Z"),
      }),
      makeRecord({
        type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
        value: 120, // Breathe session (inflated)
        startDate: new Date("2024-06-01T22:00:00Z"),
        endDate: new Date("2024-06-01T22:00:05Z"),
      }),
    ];

    const count = await upsertDailyMetricsBatch(db, "apple_health", records);
    expect(count).toBe(1);
    expect(capture.values).toHaveLength(1);

    const row = capture.values[0]?.[0];
    // 45 + 50 + 120 = 215, average = 71.666...
    expect(row?.hrv).toBeCloseTo(71.66666666666667);
  });
});

describe("upsertNutritionBatch — deduplication", () => {
  it("keeps separate nutrition samples for derived daily aggregation", async () => {
    const { db, capture } = createMockDb([{ id: "food-entry-1" }]);

    const records = [
      makeRecord({
        type: "HKQuantityTypeIdentifierDietaryEnergyConsumed",
        value: 500,
        unit: "kcal",
        startDate: new Date("2024-06-01T08:00:00Z"),
        endDate: new Date("2024-06-01T08:00:00Z"),
      }),
      makeRecord({
        type: "HKQuantityTypeIdentifierDietaryEnergyConsumed",
        value: 800,
        unit: "kcal",
        startDate: new Date("2024-06-01T12:00:00Z"),
        endDate: new Date("2024-06-01T12:00:00Z"),
      }),
    ];

    const count = await upsertNutritionBatch(db, "apple_health", records);
    expect(count).toBe(2);
    expect(capture.values).toHaveLength(4);
    expect(capture.values[0]).toHaveLength(1);
    expect(capture.values[2]).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Safety-net dedup: insertWithDuplicateDiag retries with deduplicated batch
// ---------------------------------------------------------------------------

describe("insertWithDuplicateDiag — upfront dedup", () => {
  it("deduplicates before inserting when batch has duplicate conflict keys", async () => {
    const insertCalls: Record<string, unknown>[][] = [];

    const rows: Record<string, unknown>[] = [
      { providerId: "apple_health", externalId: "dup-key", weightKg: 80 },
      { providerId: "apple_health", externalId: "dup-key", weightKg: 81 },
    ];

    const doInsert = vi.fn(async (batch: Record<string, unknown>[]) => {
      insertCalls.push(batch);
    });

    await insertWithDuplicateDiag(
      "metric_stream",
      (row) => `${row.providerId}:${row.externalId}`,
      rows,
      doInsert,
    );

    // Only one call with deduplicated rows
    expect(doInsert).toHaveBeenCalledTimes(1);
    expect(insertCalls[0]).toHaveLength(1);
    expect(insertCalls[0]?.[0]).toEqual({
      providerId: "apple_health",
      externalId: "dup-key",
      weightKg: 81,
    });
  });

  it("passes through rows unchanged when no duplicates", async () => {
    const rows: Record<string, unknown>[] = [
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ];

    const doInsert = vi.fn(async () => {});

    await insertWithDuplicateDiag("test", (row) => String(row.id), rows, doInsert);

    expect(doInsert).toHaveBeenCalledTimes(1);
    expect(doInsert).toHaveBeenCalledWith(rows);
  });

  it("propagates insert errors", async () => {
    const doInsert = vi.fn(async () => {
      throw new Error("connection reset");
    });

    await expect(
      insertWithDuplicateDiag("test", (row) => String(row.id), [{ id: 1 }], doInsert),
    ).rejects.toThrow("connection reset");

    expect(doInsert).toHaveBeenCalledTimes(1);
  });
});
