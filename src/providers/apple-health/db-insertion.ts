import { sql } from "drizzle-orm";
import type { SyncDatabase } from "../../db/index.ts";
import {
  activity,
  bodyMeasurement,
  dailyMetrics,
  healthEvent,
  labResult,
  metricStream,
  nutritionDaily,
  sleepSession,
} from "../../db/schema.ts";
import type { HealthRecord } from "./records.ts";
import type { SleepAnalysisRecord } from "./sleep.ts";
import type { HealthWorkout } from "./workouts.ts";

/**
 * Helper to catch and re-throw the "ON CONFLICT DO UPDATE command cannot affect
 * row a second time" PostgreSQL error with diagnostic information about which
 * table and which duplicate keys caused it. This error means a single INSERT
 * batch contained duplicate conflict-target values.
 */
async function insertWithDuplicateDiag<T extends Record<string, unknown>>(
  label: string,
  conflictKey: (row: T) => string,
  rows: T[],
  doInsert: (rows: T[]) => Promise<unknown>,
): Promise<void> {
  try {
    await doInsert(rows);
  } catch (err) {
    if (err instanceof Error && err.message.includes("cannot affect row a second time")) {
      const seen = new Map<string, number>();
      const dupes: string[] = [];
      for (const row of rows) {
        const key = conflictKey(row);
        const count = (seen.get(key) ?? 0) + 1;
        seen.set(key, count);
        if (count === 2) dupes.push(key);
      }
      console.error(
        `[apple_health] Duplicate conflict keys in ${label} batch (${rows.length} rows, ${dupes.length} dupes): ${dupes.slice(0, 5).join(", ")}`,
      );
    }
    throw err;
  }
}

// Records that map to metric_stream (granular time-series)
export const METRIC_STREAM_TYPES: Record<string, string> = {
  HKQuantityTypeIdentifierHeartRate: "heartRate",
  HKQuantityTypeIdentifierOxygenSaturation: "spo2",
  HKQuantityTypeIdentifierRespiratoryRate: "respiratoryRate",
  HKQuantityTypeIdentifierBloodGlucose: "bloodGlucose",
  HKQuantityTypeIdentifierEnvironmentalAudioExposure: "audioExposure",
  HKQuantityTypeIdentifierHeadphoneAudioExposure: "audioExposure",
};

// Records that map to body_measurement
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
  "HKQuantityTypeIdentifierRestingHeartRate",
  "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
  "HKQuantityTypeIdentifierVO2Max",
  "HKQuantityTypeIdentifierStepCount",
  "HKQuantityTypeIdentifierActiveEnergyBurned",
  "HKQuantityTypeIdentifierBasalEnergyBurned",
  "HKQuantityTypeIdentifierDistanceWalkingRunning",
  "HKQuantityTypeIdentifierDistanceCycling",
  "HKQuantityTypeIdentifierFlightsClimbed",
  "HKQuantityTypeIdentifierAppleExerciseTime",
  "HKQuantityTypeIdentifierAppleStandTime",
  "HKQuantityTypeIdentifierWalkingSpeed",
  "HKQuantityTypeIdentifierWalkingStepLength",
  "HKQuantityTypeIdentifierWalkingDoubleSupportPercentage",
  "HKQuantityTypeIdentifierWalkingAsymmetryPercentage",
  "HKQuantityTypeIdentifierAppleWalkingSteadiness",
  "HKQuantityTypeIdentifierWalkingHeartRateAverage",
]);

// Additive daily metrics (summed across all records in a day)
const ADDITIVE_DAILY_TYPES = new Set([
  "HKQuantityTypeIdentifierStepCount",
  "HKQuantityTypeIdentifierActiveEnergyBurned",
  "HKQuantityTypeIdentifierBasalEnergyBurned",
  "HKQuantityTypeIdentifierDistanceWalkingRunning",
  "HKQuantityTypeIdentifierDistanceCycling",
  "HKQuantityTypeIdentifierFlightsClimbed",
  "HKQuantityTypeIdentifierAppleExerciseTime",
  "HKQuantityTypeIdentifierAppleStandTime",
]);

// Nutrition records -> nutritionDaily (aggregate by day)
export const NUTRITION_TYPES: Record<string, string> = {
  HKQuantityTypeIdentifierDietaryEnergyConsumed: "calories",
  HKQuantityTypeIdentifierDietaryProtein: "proteinG",
  HKQuantityTypeIdentifierDietaryCarbohydrates: "carbsG",
  HKQuantityTypeIdentifierDietaryFatTotal: "fatG",
  HKQuantityTypeIdentifierDietaryFiber: "fiberG",
  HKQuantityTypeIdentifierDietaryWater: "waterMl",
};

// All explicitly routed types -- anything not here goes to health_event
export const ALL_ROUTED_TYPES = new Set([
  ...Object.keys(METRIC_STREAM_TYPES),
  ...BODY_MEASUREMENT_TYPES,
  ...DAILY_METRIC_TYPES,
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
): Promise<number> {
  const rows: (typeof metricStream.$inferInsert)[] = [];
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
    }
  }

  for (let i = 0; i < rows.length; i += 1000) {
    await db.insert(metricStream).values(rows.slice(i, i + 1000));
  }
  return rows.length;
}

export async function upsertBodyMeasurementBatch(
  db: SyncDatabase,
  providerId: string,
  records: HealthRecord[],
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

  const rows: (typeof bodyMeasurement.$inferInsert)[] = [];
  for (const [, group] of byTime) {
    const first = group[0];
    if (!first) continue;
    const externalId = `ah:body:${first.startDate.toISOString()}`;
    const row: typeof bodyMeasurement.$inferInsert = {
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

  // Multi-row upsert with COALESCE to preserve existing non-null values
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    await insertWithDuplicateDiag(
      "body_measurement",
      (row) => `${row.providerId}:${row.externalId}`,
      batch,
      (b) =>
        db
          .insert(bodyMeasurement)
          .values(b)
          .onConflictDoUpdate({
            target: [bodyMeasurement.providerId, bodyMeasurement.externalId],
            set: {
              recordedAt: sql`excluded.recorded_at`,
              weightKg: sql`coalesce(excluded.weight_kg, ${bodyMeasurement.weightKg})`,
              bodyFatPct: sql`coalesce(excluded.body_fat_pct, ${bodyMeasurement.bodyFatPct})`,
              muscleMassKg: sql`coalesce(excluded.muscle_mass_kg, ${bodyMeasurement.muscleMassKg})`,
              boneMassKg: sql`coalesce(excluded.bone_mass_kg, ${bodyMeasurement.boneMassKg})`,
              waterPct: sql`coalesce(excluded.water_pct, ${bodyMeasurement.waterPct})`,
              bmi: sql`coalesce(excluded.bmi, ${bodyMeasurement.bmi})`,
              heightCm: sql`coalesce(excluded.height_cm, ${bodyMeasurement.heightCm})`,
              waistCircumferenceCm: sql`coalesce(excluded.waist_circumference_cm, ${bodyMeasurement.waistCircumferenceCm})`,
              systolicBp: sql`coalesce(excluded.systolic_bp, ${bodyMeasurement.systolicBp})`,
              diastolicBp: sql`coalesce(excluded.diastolic_bp, ${bodyMeasurement.diastolicBp})`,
              heartPulse: sql`coalesce(excluded.heart_pulse, ${bodyMeasurement.heartPulse})`,
              temperatureC: sql`coalesce(excluded.temperature_c, ${bodyMeasurement.temperatureC})`,
              sourceName: sql`coalesce(excluded.source_name, ${bodyMeasurement.sourceName})`,
            },
          }),
    );
  }
  return rows.length;
}

export async function upsertDailyMetricsBatch(
  db: SyncDatabase,
  providerId: string,
  records: HealthRecord[],
): Promise<number> {
  // Aggregate by date -- sum steps/energy, take latest for point-in-time values
  const byDate = new Map<string, Map<string, number>>();
  for (const r of records) {
    if (!DAILY_METRIC_TYPES.has(r.type)) continue;
    const dateKey = dateToString(r.startDate);
    if (!byDate.has(dateKey)) byDate.set(dateKey, new Map());
    const day = byDate.get(dateKey) ?? new Map();

    if (ADDITIVE_DAILY_TYPES.has(r.type)) {
      day.set(r.type, (day.get(r.type) ?? 0) + r.value);
    } else {
      // Point-in-time: keep latest
      day.set(r.type, r.value);
    }
  }

  const rows: { row: typeof dailyMetrics.$inferInsert }[] = [];
  for (const [dateKey, metrics] of byDate) {
    const row: typeof dailyMetrics.$inferInsert = {
      date: dateKey,
      providerId,
    };

    for (const [type, value] of metrics) {
      switch (type) {
        case "HKQuantityTypeIdentifierRestingHeartRate":
          row.restingHr = Math.round(value);
          break;
        case "HKQuantityTypeIdentifierHeartRateVariabilitySDNN":
          row.hrv = value;
          break;
        case "HKQuantityTypeIdentifierVO2Max":
          row.vo2max = value;
          break;
        case "HKQuantityTypeIdentifierStepCount":
          row.steps = Math.round(value);
          break;
        case "HKQuantityTypeIdentifierActiveEnergyBurned":
          row.activeEnergyKcal = value;
          break;
        case "HKQuantityTypeIdentifierBasalEnergyBurned":
          row.basalEnergyKcal = value;
          break;
        case "HKQuantityTypeIdentifierDistanceWalkingRunning":
          row.distanceKm = value / 1000;
          break;
        case "HKQuantityTypeIdentifierDistanceCycling":
          row.cyclingDistanceKm = value / 1000;
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
          row.restingHr = row.restingHr ?? Math.round(value);
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
      (row) => `${row.date}:${row.providerId}`,
      batch,
      (b) =>
        db
          .insert(dailyMetrics)
          .values(b)
          .onConflictDoUpdate({
            target: [dailyMetrics.date, dailyMetrics.providerId],
            set: {
              restingHr: sql`coalesce(excluded.resting_hr, ${dailyMetrics.restingHr})`,
              hrv: sql`coalesce(excluded.hrv, ${dailyMetrics.hrv})`,
              vo2max: sql`coalesce(excluded.vo2max, ${dailyMetrics.vo2max})`,
              spo2Avg: sql`coalesce(excluded.spo2_avg, ${dailyMetrics.spo2Avg})`,
              respiratoryRateAvg: sql`coalesce(excluded.respiratory_rate_avg, ${dailyMetrics.respiratoryRateAvg})`,
              steps: sql`coalesce(excluded.steps, ${dailyMetrics.steps})`,
              activeEnergyKcal: sql`coalesce(excluded.active_energy_kcal, ${dailyMetrics.activeEnergyKcal})`,
              basalEnergyKcal: sql`coalesce(excluded.basal_energy_kcal, ${dailyMetrics.basalEnergyKcal})`,
              distanceKm: sql`coalesce(excluded.distance_km, ${dailyMetrics.distanceKm})`,
              cyclingDistanceKm: sql`coalesce(excluded.cycling_distance_km, ${dailyMetrics.cyclingDistanceKm})`,
              flightsClimbed: sql`coalesce(excluded.flights_climbed, ${dailyMetrics.flightsClimbed})`,
              exerciseMinutes: sql`coalesce(excluded.exercise_minutes, ${dailyMetrics.exerciseMinutes})`,
              walkingSpeed: sql`coalesce(excluded.walking_speed, ${dailyMetrics.walkingSpeed})`,
              walkingStepLength: sql`coalesce(excluded.walking_step_length, ${dailyMetrics.walkingStepLength})`,
              walkingDoubleSupportPct: sql`coalesce(excluded.walking_double_support_pct, ${dailyMetrics.walkingDoubleSupportPct})`,
              walkingAsymmetryPct: sql`coalesce(excluded.walking_asymmetry_pct, ${dailyMetrics.walkingAsymmetryPct})`,
              walkingSteadiness: sql`coalesce(excluded.walking_steadiness, ${dailyMetrics.walkingSteadiness})`,
              standHours: sql`coalesce(excluded.stand_hours, ${dailyMetrics.standHours})`,
              environmentalAudioExposure: sql`coalesce(excluded.environmental_audio_exposure, ${dailyMetrics.environmentalAudioExposure})`,
              headphoneAudioExposure: sql`coalesce(excluded.headphone_audio_exposure, ${dailyMetrics.headphoneAudioExposure})`,
              skinTempC: sql`coalesce(excluded.skin_temp_c, ${dailyMetrics.skinTempC})`,
            },
          }),
    );
  }
  return insertRows.length;
}

export async function upsertNutritionBatch(
  db: SyncDatabase,
  providerId: string,
  records: HealthRecord[],
): Promise<number> {
  // Aggregate nutrition by date
  const byDate = new Map<string, Map<string, number>>();
  for (const r of records) {
    const field = NUTRITION_TYPES[r.type];
    if (!field) continue;
    const dateKey = dateToString(r.startDate);
    if (!byDate.has(dateKey)) byDate.set(dateKey, new Map());
    const day = byDate.get(dateKey) ?? new Map();
    day.set(field, (day.get(field) ?? 0) + r.value);
  }

  const rows: { row: typeof nutritionDaily.$inferInsert }[] = [];
  for (const [dateKey, nutrients] of byDate) {
    const row: typeof nutritionDaily.$inferInsert = {
      date: dateKey,
      providerId,
    };

    for (const [field, value] of nutrients) {
      switch (field) {
        case "calories":
          row.calories = Math.round(value);
          break;
        case "proteinG":
          row.proteinG = value;
          break;
        case "carbsG":
          row.carbsG = value;
          break;
        case "fatG":
          row.fatG = value;
          break;
        case "fiberG":
          row.fiberG = value;
          break;
        case "waterMl":
          row.waterMl = Math.round(value);
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
      "nutrition_daily",
      (row) => `${row.date}:${row.providerId}`,
      batch,
      (b) =>
        db
          .insert(nutritionDaily)
          .values(b)
          .onConflictDoUpdate({
            target: [nutritionDaily.date, nutritionDaily.providerId],
            set: {
              calories: sql`coalesce(excluded.calories, ${nutritionDaily.calories})`,
              proteinG: sql`coalesce(excluded.protein_g, ${nutritionDaily.proteinG})`,
              carbsG: sql`coalesce(excluded.carbs_g, ${nutritionDaily.carbsG})`,
              fatG: sql`coalesce(excluded.fat_g, ${nutritionDaily.fatG})`,
              fiberG: sql`coalesce(excluded.fiber_g, ${nutritionDaily.fiberG})`,
              waterMl: sql`coalesce(excluded.water_ml, ${nutritionDaily.waterMl})`,
            },
          }),
    );
  }
  return insertRows.length;
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
): Promise<number> {
  // Deduplicate by externalId — Apple Health can export duplicate workouts
  // from multiple sources (Apple Watch + iPhone) with the same start time.
  // PostgreSQL rejects ON CONFLICT DO UPDATE when the same row appears twice
  // in a single INSERT statement.
  const dedupMap = new Map<string, HealthWorkout>();
  for (const w of workouts) {
    dedupMap.set(`ah:workout:${w.startDate.toISOString()}`, w);
  }
  const uniqueWorkouts = [...dedupMap.values()];

  // Multi-row upsert with RETURNING to get all activity IDs in one statement
  const activityResults: { activityId: string; workout: HealthWorkout }[] = [];

  for (let i = 0; i < uniqueWorkouts.length; i += 500) {
    const batch = uniqueWorkouts.slice(i, i + 500);
    const insertRows = batch.map((w) => ({
      providerId,
      externalId: `ah:workout:${w.startDate.toISOString()}`,
      activityType: w.activityType,
      startedAt: w.startDate,
      endedAt: w.endDate,
      name: w.activityType,
      sourceName: w.sourceName,
    }));

    const returned = await db
      .insert(activity)
      .values(insertRows)
      .onConflictDoUpdate({
        target: [activity.providerId, activity.externalId],
        set: {
          activityType: sql`excluded.activity_type`,
          endedAt: sql`excluded.ended_at`,
          sourceName: sql`coalesce(excluded.source_name, ${activity.sourceName})`,
        },
      })
      .returning({ id: activity.id });

    for (let j = 0; j < returned.length; j++) {
      const ret = returned[j];
      const work = batch[j];
      if (ret && work) {
        activityResults.push({ activityId: ret.id, workout: work });
      }
    }
  }

  // Batch all GPS route locations across all workouts
  const allGpsRows: (typeof metricStream.$inferInsert)[] = [];
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
          speed: loc.speed,
          gpsAccuracy:
            loc.horizontalAccuracy != null ? Math.round(loc.horizontalAccuracy) : undefined,
          sourceName: workout.sourceName,
        });
      }
    }
  }

  for (let i = 0; i < allGpsRows.length; i += 5000) {
    await db.insert(metricStream).values(allGpsRows.slice(i, i + 5000));
  }

  return activityResults.length;
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

  // Build all sleep session rows, then upsert in parallel
  const sleepRows = inBedRecords.map((bed) => {
    const stages = stageRecords.filter(
      (s) => s.startDate >= bed.startDate && s.endDate <= bed.endDate,
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

    const totalSleepMinutes = deepMinutes + remMinutes + lightMinutes;
    const externalId = `ah:sleep:${bed.startDate.toISOString()}`;
    const isNap = bed.durationMinutes < 120;

    return {
      bed,
      deepMinutes,
      remMinutes,
      lightMinutes,
      awakeMinutes,
      totalSleepMinutes,
      externalId,
      isNap,
    };
  });

  // Multi-row upsert -- all sleep rows have the same column shape
  const insertRows = sleepRows.map((s) => ({
    providerId,
    externalId: s.externalId,
    startedAt: s.bed.startDate,
    endedAt: s.bed.endDate,
    durationMinutes: s.bed.durationMinutes,
    deepMinutes: s.deepMinutes || undefined,
    remMinutes: s.remMinutes || undefined,
    lightMinutes: s.lightMinutes || undefined,
    awakeMinutes: s.awakeMinutes || undefined,
    efficiencyPct:
      s.bed.durationMinutes > 0
        ? Math.round((s.totalSleepMinutes / s.bed.durationMinutes) * 100) / 100
        : undefined,
    isNap: s.isNap,
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
            target: [sleepSession.providerId, sleepSession.externalId],
            set: {
              endedAt: sql`excluded.ended_at`,
              durationMinutes: sql`excluded.duration_minutes`,
              deepMinutes: sql`excluded.deep_minutes`,
              remMinutes: sql`excluded.rem_minutes`,
              lightMinutes: sql`excluded.light_minutes`,
              awakeMinutes: sql`excluded.awake_minutes`,
              isNap: sql`excluded.is_nap`,
              sourceName: sql`coalesce(excluded.source_name, ${sleepSession.sourceName})`,
            },
          }),
    );
  }
  return insertRows.length;
}
