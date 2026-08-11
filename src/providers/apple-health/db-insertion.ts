import { selectDailyHeartRateVariability } from "@dofek/heart-rate-variability";
import { isIndoorCyclingModality } from "@dofek/training/endurance-types";
import { eq, sql } from "drizzle-orm";
import type { Database, SyncDatabase } from "../../db/index.ts";
import {
  type MetricStreamSourceRow,
  writeMetricStreamBatch,
  writeMetricStreamBatchForScope,
} from "../../db/metric-stream-writer.ts";
import { NUTRIENT_ID_MAP } from "../../db/nutrient-columns.ts";
import { upsertProviderActivity } from "../../db/provider-activity-sync.ts";
import { activity, dailyMetrics, sleepSession, sleepStage } from "../../db/schema/activity.ts";
import { healthEvent, labResult } from "../../db/schema/clinical.ts";
import { foodEntry, foodEntryNutrient } from "../../db/schema/nutrition.ts";
import { SOURCE_TYPE_FILE } from "../../db/sensor-channels.ts";
import { getTokenUserId } from "../../db/token-user-context.ts";
import { logger } from "../../logger.ts";
import type { MetricStreamDeleteScopeInput } from "../../metric-stream/events.ts";
import type { MetricStreamEventPublisher } from "../../metric-stream/redpanda-producer.ts";
import { replaceHangTenIntervals } from "./hang-ten-intervals.ts";
import type { HealthRecord } from "./records.ts";
import type { SleepAnalysisRecord } from "./sleep.ts";
import { type HealthWorkout, workoutExternalId } from "./workouts.ts";

type TransactionalSyncDatabase = SyncDatabase & Pick<Database, "transaction">;

function hasTransaction(db: SyncDatabase): db is TransactionalSyncDatabase {
  return "transaction" in db && typeof db.transaction === "function";
}

function requireTransactionalDatabase(db: SyncDatabase): TransactionalSyncDatabase {
  if (!hasTransaction(db)) {
    throw new Error("Apple Health workout upsert requires a transactional database");
  }
  return db;
}

/**
 * Deduplicate rows by their conflict key, keeping the last occurrence.
 * Returns the deduplicated rows if any duplicates were found, or the
 * original array if all keys are unique.
 */
function deduplicateByKey<T>(rows: T[], conflictKey: (row: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const row of rows) {
    seen.set(conflictKey(row), row);
  }
  return seen.size === rows.length ? rows : [...seen.values()];
}

/**
 * Insert rows with automatic deduplication on the "ON CONFLICT DO UPDATE
 * command cannot affect row a second time" PostgreSQL error. When a batch
 * contains duplicate conflict-target values, this helper deduplicates and
 * retries the insert instead of crashing.
 */
export async function insertWithDuplicateDiag<T extends Record<string, unknown>>(
  label: string,
  conflictKey: (row: T) => string,
  rows: T[],
  doInsert: (rows: T[]) => Promise<unknown>,
): Promise<void> {
  const uniqueRows = deduplicateByKey(rows, conflictKey);
  if (uniqueRows.length < rows.length) {
    logger.warn(
      `[apple_health] Deduplicated ${label} batch: ${rows.length} → ${uniqueRows.length} rows (${rows.length - uniqueRows.length} duplicates removed)`,
    );
  }
  await doInsert(uniqueRows);
}

// Records that map to metric stream channels (granular time-series)
export const METRIC_STREAM_TYPES: Record<string, string> = {
  HKQuantityTypeIdentifierHeartRate: "heartRate",
  HKQuantityTypeIdentifierOxygenSaturation: "spo2",
  HKQuantityTypeIdentifierRespiratoryRate: "respiratoryRate",
  HKQuantityTypeIdentifierBloodGlucose: "bloodGlucose",
  HKQuantityTypeIdentifierEnvironmentalAudioExposure: "audioExposure",
  HKQuantityTypeIdentifierHeadphoneAudioExposure: "audioExposure",
  HKQuantityTypeIdentifierAppleSleepingWristTemperature: "skinTemperature",
  HKQuantityTypeIdentifierElectrodermalActivity: "electrodermalActivity",
};

// Records that map to metric stream body channels.
export const BODY_MEASUREMENT_TYPES = new Set([
  "HKQuantityTypeIdentifierBodyMass",
  "HKQuantityTypeIdentifierBodyFatPercentage",
  "HKQuantityTypeIdentifierBodyMassIndex",
  "HKQuantityTypeIdentifierLeanBodyMass",
  "HKQuantityTypeIdentifierBloodPressureSystolic",
  "HKQuantityTypeIdentifierBloodPressureDiastolic",
  "HKQuantityTypeIdentifierBodyTemperature",
  "HKQuantityTypeIdentifierHeight",
  "HKQuantityTypeIdentifierWaistCircumference",
]);

// Records that map to daily_metrics (one value per day)
// Additive types get summed; point-in-time types keep latest value
export const DAILY_METRIC_TYPES = new Set([
  "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
  "HKQuantityTypeIdentifierStepCount",
  "HKQuantityTypeIdentifierDistanceWalkingRunning",
  "HKQuantityTypeIdentifierFlightsClimbed",
  "HKQuantityTypeIdentifierAppleExerciseTime",
  "HKQuantityTypeIdentifierAppleStandTime",
  "HKQuantityTypeIdentifierWalkingSpeed",
  "HKQuantityTypeIdentifierWalkingStepLength",
  "HKQuantityTypeIdentifierWalkingDoubleSupportPercentage",
  "HKQuantityTypeIdentifierWalkingAsymmetryPercentage",
  "HKQuantityTypeIdentifierAppleWalkingSteadiness",
  "HKQuantityTypeIdentifierWalkingHeartRateAverage",
  "HKQuantityTypeIdentifierPushCount",
  "HKQuantityTypeIdentifierDistanceWheelchair",
  "HKQuantityTypeIdentifierUVExposure",
]);

// Provider-computed summaries that are derived from raw streams server-side.
export const IGNORED_PROVIDER_DERIVED_TYPES = new Set([
  "HKQuantityTypeIdentifierActiveEnergyBurned",
  "HKQuantityTypeIdentifierBasalEnergyBurned",
  "HKQuantityTypeIdentifierRestingHeartRate",
  "HKQuantityTypeIdentifierVO2Max",
]);

// Additive daily metrics (summed across all records in a day)
const ADDITIVE_DAILY_TYPES = new Set([
  "HKQuantityTypeIdentifierStepCount",
  "HKQuantityTypeIdentifierDistanceWalkingRunning",
  "HKQuantityTypeIdentifierFlightsClimbed",
  "HKQuantityTypeIdentifierAppleExerciseTime",
  "HKQuantityTypeIdentifierAppleStandTime",
  "HKQuantityTypeIdentifierPushCount",
  "HKQuantityTypeIdentifierDistanceWheelchair",
]);

// Nutrition records -> foodEntry + foodEntryNutrient rows.
export const NUTRITION_TYPES: Record<string, string> = {
  HKQuantityTypeIdentifierDietaryEnergyConsumed: "calories",
  HKQuantityTypeIdentifierDietaryProtein: "proteinG",
  HKQuantityTypeIdentifierDietaryCarbohydrates: "carbsG",
  HKQuantityTypeIdentifierDietaryFatTotal: "fatG",
  HKQuantityTypeIdentifierDietaryFiber: "fiberG",
  HKQuantityTypeIdentifierDietaryWater: "waterMl",
  HKQuantityTypeIdentifierDietarySodium: "sodiumMg",
  HKQuantityTypeIdentifierDietarySugar: "sugarG",
  HKQuantityTypeIdentifierDietaryCholesterol: "cholesterolMg",
  HKQuantityTypeIdentifierDietaryFatSaturated: "saturatedFatG",
  HKQuantityTypeIdentifierDietaryPotassium: "potassiumMg",
  HKQuantityTypeIdentifierDietaryVitaminA: "vitaminAMcg",
  HKQuantityTypeIdentifierDietaryVitaminC: "vitaminCMg",
  HKQuantityTypeIdentifierDietaryVitaminD: "vitaminDMcg",
  HKQuantityTypeIdentifierDietaryCalcium: "calciumMg",
  HKQuantityTypeIdentifierDietaryIron: "ironMg",
  HKQuantityTypeIdentifierDietaryMagnesium: "magnesiumMg",
  HKQuantityTypeIdentifierDietaryZinc: "zincMg",
};

// All explicitly routed types -- anything not here goes to health_event
export const ALL_ROUTED_TYPES = new Set([
  ...Object.keys(METRIC_STREAM_TYPES),
  ...BODY_MEASUREMENT_TYPES,
  ...DAILY_METRIC_TYPES,
  ...IGNORED_PROVIDER_DERIVED_TYPES,
  ...Object.keys(NUTRITION_TYPES),
  "HKCategoryTypeIdentifierSleepAnalysis", // handled separately in SAX parser
]);

function dateToString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export { labResult };

export async function upsertMetricStreamBatch(
  db: SyncDatabase,
  providerId: string,
  records: HealthRecord[],
  replacementScope?: MetricStreamDeleteScopeInput,
  publisher?: MetricStreamEventPublisher,
): Promise<number> {
  const rows: MetricStreamSourceRow[] = [];
  for (const record of records) {
    const field = METRIC_STREAM_TYPES[record.type];
    if (!field) continue;

    const base = {
      providerId,
      recordedAt: record.startDate,
      sourceName: record.sourceName,
    };

    switch (field) {
      case "heartRate":
        rows.push({ ...base, heartRate: Math.round(record.value) });
        break;
      case "spo2":
        rows.push({ ...base, spo2: record.value });
        break;
      case "respiratoryRate":
        rows.push({ ...base, respiratoryRate: record.value });
        break;
      case "bloodGlucose":
        rows.push({ ...base, bloodGlucose: record.value });
        break;
      case "audioExposure":
        rows.push({ ...base, audioExposure: record.value });
        break;
      case "skinTemperature":
        rows.push({ ...base, skinTemperature: record.value });
        break;
      case "electrodermalActivity":
        rows.push({ ...base, electrodermalActivity: record.value });
        break;
    }
  }

  if (replacementScope) {
    await writeMetricStreamBatchForScope(db, replacementScope, rows, SOURCE_TYPE_FILE, publisher);
  } else {
    await writeMetricStreamBatch(db, rows, SOURCE_TYPE_FILE, undefined, publisher);
  }
  return rows.length;
}

export async function upsertBodyMeasurementBatch(
  db: SyncDatabase,
  providerId: string,
  records: HealthRecord[],
  replacementScope?: MetricStreamDeleteScopeInput,
  publisher?: MetricStreamEventPublisher,
): Promise<number> {
  // Group by timestamp to combine BP systolic + diastolic into one row
  const byTime = new Map<string, HealthRecord[]>();
  for (const r of records) {
    if (!BODY_MEASUREMENT_TYPES.has(r.type)) continue;
    const key = r.startDate.toISOString();
    const group = byTime.get(key) ?? [];
    group.push(r);
    byTime.set(key, group);
  }

  const rows: MetricStreamSourceRow[] = [];
  for (const [, group] of byTime) {
    const first = group[0];
    if (!first) continue;
    const externalId = `ah:body:${first.startDate.toISOString()}`;
    const row: MetricStreamSourceRow = {
      providerId,
      externalId,
      recordedAt: first.startDate,
      sourceName: first.sourceName,
    };

    for (const r of group) {
      switch (r.type) {
        case "HKQuantityTypeIdentifierBodyMass":
          row.weightKg = r.value;
          break;
        case "HKQuantityTypeIdentifierBodyFatPercentage":
          row.bodyFatPct = r.value * 100;
          break;
        case "HKQuantityTypeIdentifierBodyMassIndex":
          row.bmi = r.value;
          break;
        case "HKQuantityTypeIdentifierBloodPressureSystolic":
          row.systolicBp = Math.round(r.value);
          break;
        case "HKQuantityTypeIdentifierBloodPressureDiastolic":
          row.diastolicBp = Math.round(r.value);
          break;
        case "HKQuantityTypeIdentifierBodyTemperature":
          row.temperatureC = r.value;
          break;
        case "HKQuantityTypeIdentifierHeight":
          row.heightCm = r.unit === "m" ? r.value * 100 : r.value;
          break;
        case "HKQuantityTypeIdentifierWaistCircumference":
          row.waistCircumferenceCm = r.unit === "m" ? r.value * 100 : r.value;
          break;
      }
    }
    rows.push(row);
  }

  // Deduplicate by externalId — Apple Health can export duplicate measurements
  // from multiple sources (Apple Watch + iPhone) with the same timestamp.
  // PostgreSQL rejects ON CONFLICT DO UPDATE when the same row appears twice
  // in a single INSERT statement.
  const dedupMap = new Map<string, MetricStreamSourceRow>();
  for (const row of rows) {
    if (row.externalId) dedupMap.set(row.externalId, row);
  }
  const uniqueRows = [...dedupMap.values()];

  if (replacementScope) {
    await writeMetricStreamBatchForScope(
      db,
      replacementScope,
      uniqueRows,
      SOURCE_TYPE_FILE,
      publisher,
    );
  } else {
    await writeMetricStreamBatch(db, uniqueRows, SOURCE_TYPE_FILE, undefined, publisher);
  }
  return uniqueRows.length;
}

export async function upsertDailyMetricsBatch(
  db: SyncDatabase,
  providerId: string,
  records: HealthRecord[],
): Promise<number> {
  // Aggregate by (date, source) -- each source device gets its own row.
  // Deduplication happens at query time in the v_daily_metrics materialized view.
  const byDateSource = new Map<string, Map<string, number>>();
  const heartRateVariabilitySamplesByDateSource = new Map<
    string,
    Array<{ value: number; startDate: Date }>
  >();
  for (const r of records) {
    if (!DAILY_METRIC_TYPES.has(r.type)) continue;
    const dateKey = r.startDateCalendarDay ?? dateToString(r.startDate);
    const sourceName = r.sourceName ?? null;
    const compoundKey = `${dateKey}\0${sourceName}`;
    if (!byDateSource.has(compoundKey)) byDateSource.set(compoundKey, new Map());
    const day = byDateSource.get(compoundKey) ?? new Map();

    if (ADDITIVE_DAILY_TYPES.has(r.type)) {
      day.set(r.type, (day.get(r.type) ?? 0) + r.value);
    } else if (r.type === "HKQuantityTypeIdentifierHeartRateVariabilitySDNN") {
      const daySamples = heartRateVariabilitySamplesByDateSource.get(compoundKey) ?? [];
      daySamples.push({ value: r.value, startDate: r.startDate });
      heartRateVariabilitySamplesByDateSource.set(compoundKey, daySamples);
    } else {
      // Point-in-time: keep latest
      day.set(r.type, r.value);
    }
  }

  // Select overnight HRV for each (date, source) using shared logic
  for (const [
    compoundKey,
    heartRateVariabilitySamples,
  ] of heartRateVariabilitySamplesByDateSource) {
    const day = byDateSource.get(compoundKey);
    const selected = selectDailyHeartRateVariability(heartRateVariabilitySamples);
    if (day && selected !== null) {
      day.set("HKQuantityTypeIdentifierHeartRateVariabilitySDNN", selected);
    }
  }

  const rows: { row: typeof dailyMetrics.$inferInsert }[] = [];
  for (const [compoundKey, metrics] of byDateSource) {
    const separatorIndex = compoundKey.indexOf("\0");
    const dateKey = compoundKey.slice(0, separatorIndex);
    const sourceName = compoundKey.slice(separatorIndex + 1);
    const row: typeof dailyMetrics.$inferInsert = {
      date: dateKey,
      providerId,
      sourceName,
    };

    for (const [type, value] of metrics) {
      switch (type) {
        case "HKQuantityTypeIdentifierHeartRateVariabilitySDNN":
          row.hrv = value;
          break;
        case "HKQuantityTypeIdentifierStepCount":
          row.steps = Math.round(value);
          break;
        case "HKQuantityTypeIdentifierDistanceWalkingRunning":
          row.distanceKm = value / 1000;
          break;
        case "HKQuantityTypeIdentifierFlightsClimbed":
          row.flightsClimbed = Math.round(value);
          break;
        case "HKQuantityTypeIdentifierAppleExerciseTime":
          row.exerciseMinutes = Math.round(value);
          break;
        case "HKQuantityTypeIdentifierAppleStandTime":
          row.standHours = Math.round(value / 60);
          break;
        case "HKQuantityTypeIdentifierWalkingSpeed":
          row.walkingSpeed = value;
          break;
        case "HKQuantityTypeIdentifierWalkingStepLength":
          row.walkingStepLength = value;
          break;
        case "HKQuantityTypeIdentifierWalkingDoubleSupportPercentage":
          row.walkingDoubleSupportPct = value;
          break;
        case "HKQuantityTypeIdentifierWalkingAsymmetryPercentage":
          row.walkingAsymmetryPct = value;
          break;
        case "HKQuantityTypeIdentifierAppleWalkingSteadiness":
          row.walkingSteadiness = value;
          break;
        case "HKQuantityTypeIdentifierWalkingHeartRateAverage":
          // Do nothing - walking average is not resting HR
          break;
        case "HKQuantityTypeIdentifierPushCount":
          row.pushCount = Math.round(value);
          break;
        case "HKQuantityTypeIdentifierDistanceWheelchair":
          row.wheelchairDistanceKm = value / 1000;
          break;
        case "HKQuantityTypeIdentifierUVExposure":
          row.uvExposure = value;
          break;
      }
    }
    rows.push({ row });
  }

  // Multi-row upsert with COALESCE to preserve existing non-null values
  const insertRows = rows.map(({ row }) => row);
  for (let i = 0; i < insertRows.length; i += 500) {
    const batch = insertRows.slice(i, i + 500);
    await insertWithDuplicateDiag(
      "daily_metrics",
      (row) => `${row.date}:${row.providerId}:${row.sourceName}`,
      batch,
      (b) =>
        db
          .insert(dailyMetrics)
          .values(b)
          .onConflictDoUpdate({
            target: [
              dailyMetrics.userId,
              dailyMetrics.date,
              dailyMetrics.providerId,
              dailyMetrics.sourceName,
            ],
            set: {
              // Point-in-time metrics: prefer new value, fall back to existing
              hrv: sql`coalesce(excluded.hrv, ${dailyMetrics.hrv})`,
              spo2Avg: sql`coalesce(excluded.spo2_avg, ${dailyMetrics.spo2Avg})`,
              respiratoryRateAvg: sql`coalesce(excluded.respiratory_rate_avg, ${dailyMetrics.respiratoryRateAvg})`,
              walkingSpeed: sql`coalesce(excluded.walking_speed, ${dailyMetrics.walkingSpeed})`,
              walkingStepLength: sql`coalesce(excluded.walking_step_length, ${dailyMetrics.walkingStepLength})`,
              walkingDoubleSupportPct: sql`coalesce(excluded.walking_double_support_pct, ${dailyMetrics.walkingDoubleSupportPct})`,
              walkingAsymmetryPct: sql`coalesce(excluded.walking_asymmetry_pct, ${dailyMetrics.walkingAsymmetryPct})`,
              walkingSteadiness: sql`coalesce(excluded.walking_steadiness, ${dailyMetrics.walkingSteadiness})`,
              skinTempC: sql`coalesce(excluded.skin_temp_c, ${dailyMetrics.skinTempC})`,
              // Additive metrics: accumulate across batches (import.ts clears before import)
              steps: sql`coalesce(${dailyMetrics.steps}, 0) + coalesce(excluded.steps, 0)`,
              distanceKm: sql`coalesce(${dailyMetrics.distanceKm}, 0) + coalesce(excluded.distance_km, 0)`,
              flightsClimbed: sql`coalesce(${dailyMetrics.flightsClimbed}, 0) + coalesce(excluded.flights_climbed, 0)`,
              exerciseMinutes: sql`coalesce(${dailyMetrics.exerciseMinutes}, 0) + coalesce(excluded.exercise_minutes, 0)`,
              standHours: sql`coalesce(${dailyMetrics.standHours}, 0) + coalesce(excluded.stand_hours, 0)`,
              pushCount: sql`coalesce(${dailyMetrics.pushCount}, 0) + coalesce(excluded.push_count, 0)`,
              wheelchairDistanceKm: sql`coalesce(${dailyMetrics.wheelchairDistanceKm}, 0) + coalesce(excluded.wheelchair_distance_km, 0)`,
              // Point-in-time: UV exposure
              uvExposure: sql`coalesce(excluded.uv_exposure, ${dailyMetrics.uvExposure})`,
            },
          }),
    );
  }
  return insertRows.length;
}

async function aggregateMetricRecordsToDailyMetrics(
  db: SyncDatabase,
  providerId: string,
  records: readonly HealthRecord[],
  type: string,
  column: "skinTempC" | "spo2Avg",
  valueScale: number,
): Promise<void> {
  const userId = getTokenUserId();
  if (!userId) {
    throw new Error("apple-health import requires user context");
  }
  const groupedRecords = new Map<
    string,
    { date: string; total: number; count: number; sourceName: string }
  >();

  for (const record of records) {
    if (record.type !== type) continue;
    const date = dateToString(record.startDate);
    const sourceName = record.sourceName ?? "unknown";
    const key = `${date}\0${sourceName}`;
    const grouped = groupedRecords.get(key) ?? {
      date,
      total: 0,
      count: 0,
      sourceName,
    };
    grouped.total += record.value * valueScale;
    grouped.count++;
    groupedRecords.set(key, grouped);
  }

  const rows = [...groupedRecords.values()].map((grouped) => ({
    date: grouped.date,
    providerId,
    userId,
    sourceName: grouped.sourceName,
    [column]: grouped.total / grouped.count,
  }));
  if (rows.length === 0) return;

  const set =
    column === "spo2Avg"
      ? { spo2Avg: sql`EXCLUDED.spo2_avg` }
      : { skinTempC: sql`EXCLUDED.skin_temp_c` };

  await db
    .insert(dailyMetrics)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        dailyMetrics.userId,
        dailyMetrics.date,
        dailyMetrics.providerId,
        dailyMetrics.sourceName,
      ],
      set,
    });
}

/**
 * Aggregate SpO2 readings from Apple Health metric records into daily_metrics.spo2_avg.
 * Apple Health stores SpO2 as fractions (0-1); this converts the daily average
 * to a percentage (0-100) for consistency with providers that report SpO2 as a percentage.
 */
export async function aggregateSpO2ToDailyMetrics(
  db: SyncDatabase,
  providerId: string,
  records: readonly HealthRecord[],
): Promise<void> {
  await aggregateMetricRecordsToDailyMetrics(
    db,
    providerId,
    records,
    "HKQuantityTypeIdentifierOxygenSaturation",
    "spo2Avg",
    100,
  );
}

/**
 * Aggregate wrist temperature readings from Apple Health metric records into daily_metrics.skin_temp_c.
 * Apple Watch reports sleeping wrist temperature in °C; this computes the daily
 * average and stores it alongside other daily metrics.
 */
export async function aggregateSkinTempToDailyMetrics(
  db: SyncDatabase,
  providerId: string,
  records: readonly HealthRecord[],
): Promise<void> {
  await aggregateMetricRecordsToDailyMetrics(
    db,
    providerId,
    records,
    "HKQuantityTypeIdentifierAppleSleepingWristTemperature",
    "skinTempC",
    1,
  );
}

export async function upsertNutritionBatch(
  db: SyncDatabase,
  providerId: string,
  records: HealthRecord[],
): Promise<number> {
  let count = 0;
  for (const r of records) {
    const field = NUTRITION_TYPES[r.type];
    if (!field) continue;
    const dateKey = r.startDateCalendarDay ?? dateToString(r.startDate);
    const externalId = [
      "ah",
      "nutrition",
      r.type,
      r.sourceName ?? "unknown-source",
      r.startDate.toISOString(),
      r.endDate.toISOString(),
    ].join(":");
    const raw = {
      type: r.type,
      unit: r.unit,
      value: r.value,
      sourceName: r.sourceName,
      startDate: r.startDate.toISOString(),
      endDate: r.endDate.toISOString(),
      creationDate: r.creationDate?.toISOString(),
    };
    const foodRows = await db
      .insert(foodEntry)
      .values([
        {
          providerId,
          externalId,
          date: dateKey,
          nutritionGrain: "daily_aggregate",
          foodName: null,
          sourceName: r.sourceName,
          loggedAt: r.creationDate ?? r.startDate,
          startedAt: r.startDate,
          endedAt: r.endDate,
          raw,
          confirmed: true,
        },
      ])
      .onConflictDoUpdate({
        target: [foodEntry.userId, foodEntry.providerId, foodEntry.externalId],
        set: {
          date: dateKey,
          nutritionGrain: "daily_aggregate",
          foodName: null,
          sourceName: r.sourceName,
          loggedAt: r.creationDate ?? r.startDate,
          startedAt: r.startDate,
          endedAt: r.endDate,
          raw,
          confirmed: true,
        },
      })
      .returning({ id: foodEntry.id });
    const foodEntryId = foodRows[0]?.id;
    if (!foodEntryId) continue;

    const nutrientId = NUTRIENT_ID_MAP[field];
    if (!nutrientId) continue;

    await db
      .insert(foodEntryNutrient)
      .values([
        {
          foodEntryId,
          nutrientId,
          amount: field === "calories" || field === "waterMl" ? Math.round(r.value) : r.value,
        },
      ])
      .onConflictDoUpdate({
        target: [foodEntryNutrient.foodEntryId, foodEntryNutrient.nutrientId],
        set: {
          amount: sql`excluded.amount`,
        },
      });
    count++;
  }
  return count;
}

export async function upsertHealthEventBatch(
  db: SyncDatabase,
  providerId: string,
  records: HealthRecord[],
): Promise<number> {
  const rows: (typeof healthEvent.$inferInsert)[] = [];
  for (const r of records) {
    // Skip already-routed types
    if (ALL_ROUTED_TYPES.has(r.type)) continue;

    rows.push({
      providerId,
      externalId: `ah:${r.type}:${r.startDate.toISOString()}`,
      type: r.type,
      value: r.value,
      unit: r.unit,
      sourceName: r.sourceName,
      startDate: r.startDate,
      endDate: r.endDate,
    });
  }

  if (rows.length > 0) {
    for (let i = 0; i < rows.length; i += 5000) {
      await db
        .insert(healthEvent)
        .values(rows.slice(i, i + 5000))
        .onConflictDoNothing();
    }
  }
  return rows.length;
}

export async function upsertWorkoutBatch(
  db: SyncDatabase,
  providerId: string,
  workouts: HealthWorkout[],
  replacementScope?: MetricStreamDeleteScopeInput,
  publisher?: MetricStreamEventPublisher,
): Promise<number> {
  // Deduplicate by externalId — Apple Health can export duplicate workouts
  // from multiple sources (Apple Watch + iPhone) with the same start time.
  // PostgreSQL rejects ON CONFLICT DO UPDATE when the same row appears twice
  // in a single INSERT statement.
  const dedupMap = new Map<string, HealthWorkout>();
  for (const w of workouts) {
    dedupMap.set(workoutExternalId(w), w);
  }
  const uniqueWorkouts = [...dedupMap.values()];

  const transactionalDb = requireTransactionalDatabase(db);
  // Multi-row upsert with RETURNING to get all activity IDs in one statement.
  // Keep activity metadata and Hang Ten intervals in the same transaction so a
  // failed replacement cannot leave the activity row ahead of its intervals.
  const activityResults = await transactionalDb.transaction(async (transactionDb) => {
    const results: { activityId: string; workout: HealthWorkout }[] = [];

    const batches: HealthWorkout[][] = [];
    const remainingWorkouts = [...uniqueWorkouts];
    while (remainingWorkouts.length) {
      batches.push(remainingWorkouts.splice(0, 500));
    }
    for (const batch of batches) {
      for (const workout of batch) {
        const values = {
          providerId,
          externalId: workoutExternalId(workout),
          activityType: workout.activityType,
          startedAt: workout.startDate,
          endedAt: workout.endDate,
          name: workoutName(workout),
          sourceName: workout.sourceName,
          raw: workoutRawPayload(workout),
        };

        const returned = await upsertProviderActivity(transactionDb, values, {
          activityType: values.activityType,
          startedAt: values.startedAt,
          endedAt: values.endedAt,
          name: sql`CASE
            WHEN excluded.canonical_type = 'hangboard' AND excluded.source_name = 'Hang Ten'
              THEN excluded.name
            ELSE ${activity.name}
          END`,
          sourceName: values.sourceName,
          raw: values.raw,
        });

        if (returned) {
          results.push({ activityId: returned.id, workout });
          await replaceHangTenIntervals(transactionDb, returned.id, workout);
        }
      }
    }

    return results;
  });

  // Batch all GPS route locations across all workouts
  const allGpsRows: MetricStreamSourceRow[] = [];
  for (const { activityId, workout } of activityResults) {
    if (workout.routeLocations && workout.routeLocations.length > 0) {
      for (const loc of workout.routeLocations) {
        allGpsRows.push({
          providerId,
          activityId,
          recordedAt: loc.date,
          lat: loc.lat,
          lng: loc.lng,
          altitude: loc.altitude,
          speed: isIndoorCyclingModality(workout.activityType.modality) ? undefined : loc.speed,
          horizontalAccuracy: loc.horizontalAccuracy,
          sourceName: workout.sourceName,
        });
      }
    }
  }

  if (replacementScope) {
    await writeMetricStreamBatchForScope(
      db,
      replacementScope,
      allGpsRows,
      SOURCE_TYPE_FILE,
      publisher,
    );
  } else {
    await writeMetricStreamBatch(db, allGpsRows, SOURCE_TYPE_FILE, undefined, publisher);
  }

  return activityResults.length;
}

function workoutName(workout: HealthWorkout): string {
  return workout.hangTen?.planName ?? workout.activityType.canonicalType;
}

function workoutRawPayload(workout: HealthWorkout): Record<string, unknown> {
  const raw: Record<string, unknown> = { durationSeconds: workout.durationSeconds };
  if (workout.distanceMeters !== undefined) raw.distanceMeters = workout.distanceMeters;
  if (workout.avgHeartRate !== undefined) raw.avgHeartRate = workout.avgHeartRate;
  if (workout.maxHeartRate !== undefined) raw.maxHeartRate = workout.maxHeartRate;
  if (workout.hangTen) raw.hangTen = workout.hangTen;
  return raw;
}

export async function upsertSleepBatch(
  db: SyncDatabase,
  providerId: string,
  records: SleepAnalysisRecord[],
): Promise<number> {
  // Group sleep segments into sessions by finding "inBed" spans
  // Each inBed record is one session; we aggregate stage durations within it
  const allInBed = records.filter((r) => r.stage === "inBed");
  const stageRecords = records.filter((r) => r.stage !== "inBed");

  // Deduplicate inBed records by externalId — Apple Health can export
  // duplicate sleep sessions from multiple sources with the same start time.
  const inBedDedup = new Map<string, SleepAnalysisRecord>();
  for (const bed of allInBed) {
    inBedDedup.set(`ah:sleep:${bed.startDate.toISOString()}`, bed);
  }
  const inBedRecords = [...inBedDedup.values()];

  // Map Apple Health stage names to canonical stage names
  const APPLE_HEALTH_STAGE_MAP: Record<string, "deep" | "light" | "rem" | "awake"> = {
    deep: "deep",
    core: "light",
    asleep: "light",
    rem: "rem",
    awake: "awake",
  };

  // Build all sleep session rows, then upsert in parallel
  const sleepRows = inBedRecords.map((bed) => {
    const stages = stageRecords.filter(
      (s) => s.startDate >= bed.startDate && s.endDate <= bed.endDate,
    );

    const stagingAvailable = stages.some(
      (stage) => stage.stage === "deep" || stage.stage === "rem" || stage.stage === "core",
    );
    let deepMinutes = 0;
    let remMinutes = 0;
    let lightMinutes = 0;
    let awakeMinutes = 0;

    for (const s of stages) {
      switch (s.stage) {
        case "deep":
          deepMinutes += s.durationMinutes;
          break;
        case "rem":
          remMinutes += s.durationMinutes;
          break;
        case "core":
          lightMinutes += s.durationMinutes;
          break;
        case "awake":
          awakeMinutes += s.durationMinutes;
          break;
      }
    }

    const externalId = `ah:sleep:${bed.startDate.toISOString()}`;

    return {
      bed,
      stages,
      deepMinutes,
      remMinutes,
      lightMinutes,
      awakeMinutes,
      stagingAvailable,
      externalId,
    };
  });

  // Multi-row upsert -- all sleep rows have the same column shape
  const insertRows = sleepRows.map((s) => ({
    providerId,
    externalId: s.externalId,
    startedAt: s.bed.startDate,
    endedAt: s.bed.endDate,
    durationMinutes: s.bed.durationMinutes,
    deepMinutes: s.stagingAvailable ? s.deepMinutes : null,
    remMinutes: s.stagingAvailable ? s.remMinutes : null,
    lightMinutes: s.stagingAvailable ? s.lightMinutes : null,
    awakeMinutes:
      s.stagingAvailable || s.stages.some((stage) => stage.stage === "awake")
        ? s.awakeMinutes
        : null,
    stagingAvailable: s.stagingAvailable,
    sleepType: null,
    sourceName: s.bed.sourceName,
  }));

  for (let i = 0; i < insertRows.length; i += 500) {
    const batch = insertRows.slice(i, i + 500);
    await insertWithDuplicateDiag(
      "sleep_session",
      (row) => `${row.providerId}:${row.externalId}`,
      batch,
      (b) =>
        db
          .insert(sleepSession)
          .values(b)
          .onConflictDoUpdate({
            target: [sleepSession.userId, sleepSession.providerId, sleepSession.externalId],
            set: {
              endedAt: sql`excluded.ended_at`,
              durationMinutes: sql`excluded.duration_minutes`,
              deepMinutes: sql`excluded.deep_minutes`,
              remMinutes: sql`excluded.rem_minutes`,
              lightMinutes: sql`excluded.light_minutes`,
              awakeMinutes: sql`excluded.awake_minutes`,
              stagingAvailable: sql`excluded.staging_available`,
              sleepType: sql`excluded.sleep_type`,
              sourceName: sql`coalesce(excluded.source_name, ${sleepSession.sourceName})`,
            },
          }),
    );
  }

  // Second pass: look up session IDs and insert stage intervals
  const sessionsWithStages = sleepRows.filter((s) => s.stages.length > 0);
  if (sessionsWithStages.length > 0) {
    const sessionIds = await db
      .select({ id: sleepSession.id, externalId: sleepSession.externalId })
      .from(sleepSession)
      .where(
        sql`${sleepSession.providerId} = ${providerId}
          AND ${sleepSession.externalId} IN (${sql.join(
            sessionsWithStages.map((s) => sql`${s.externalId}`),
            sql`, `,
          )})`,
      );

    const idByExternalId = new Map(sessionIds.map((r) => [r.externalId, r.id]));

    for (const row of sessionsWithStages) {
      const sessionId = idByExternalId.get(row.externalId);
      if (!sessionId) continue;

      const stageRows = row.stages
        .map((s) => {
          const stage = APPLE_HEALTH_STAGE_MAP[s.stage];
          if (!stage) return null;
          return {
            sessionId,
            stage,
            startedAt: s.startDate,
            endedAt: s.endDate,
            sourceName: s.sourceName,
          };
        })
        .filter((s): s is NonNullable<typeof s> => s !== null);

      if (stageRows.length > 0) {
        await db.delete(sleepStage).where(eq(sleepStage.sessionId, sessionId));
        await db.insert(sleepStage).values(stageRows);
      }
    }
  }

  return insertRows.length;
}
