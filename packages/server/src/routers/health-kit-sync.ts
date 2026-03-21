import { selectDailyHeartRateVariability } from "@dofek/heart-rate-variability";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { logger } from "../logger.ts";
import { protectedProcedure, router } from "../trpc.ts";

const PROVIDER_ID = "apple_health";
const BATCH_SIZE = 500;
const MAX_SLEEP_SESSION_GAP_MS = 90 * 60 * 1000;

// ── Zod schemas ──

const healthKitSampleSchema = z.object({
  type: z.string(),
  value: z.number(),
  unit: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  sourceName: z.string(),
  sourceBundle: z.string(),
  uuid: z.string(),
});

const workoutSampleSchema = z.object({
  uuid: z.string(),
  workoutType: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  duration: z.number(),
  totalEnergyBurned: z.number().nullish(),
  totalDistance: z.number().nullish(),
  sourceName: z.string(),
  sourceBundle: z.string(),
});

const sleepSampleSchema = z.object({
  uuid: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  value: z.string(),
  sourceName: z.string(),
});

export type HealthKitSample = z.infer<typeof healthKitSampleSchema>;
type WorkoutSample = z.infer<typeof workoutSampleSchema>;
type SleepSample = z.infer<typeof sleepSampleSchema>;

// ── Type routing maps ──

/** Body measurement types and their column names */
const bodyMeasurementTypes: Record<
  string,
  { column: string; transform?: (value: number) => number }
> = {
  HKQuantityTypeIdentifierBodyMass: { column: "weight_kg" },
  HKQuantityTypeIdentifierBodyFatPercentage: {
    column: "body_fat_pct",
    transform: (value) => value * 100,
  },
  HKQuantityTypeIdentifierBodyMassIndex: { column: "bmi" },
  HKQuantityTypeIdentifierHeight: { column: "height_cm" },
};

/** Additive daily metrics -- values that should be summed within a day */
const additiveDailyMetricTypes: Record<
  string,
  { column: string; transform?: (value: number) => number }
> = {
  HKQuantityTypeIdentifierStepCount: { column: "steps" },
  HKQuantityTypeIdentifierActiveEnergyBurned: { column: "active_energy_kcal" },
  HKQuantityTypeIdentifierBasalEnergyBurned: { column: "basal_energy_kcal" },
  HKQuantityTypeIdentifierDistanceWalkingRunning: {
    column: "distance_km",
    transform: (value) => value / 1000,
  },
  HKQuantityTypeIdentifierDistanceCycling: {
    column: "cycling_distance_km",
    transform: (value) => value / 1000,
  },
  HKQuantityTypeIdentifierFlightsClimbed: { column: "flights_climbed" },
  HKQuantityTypeIdentifierAppleExerciseTime: { column: "exercise_minutes" },
};

/** Point-in-time daily metrics -- use latest value for the day */
const pointInTimeDailyMetricTypes: Record<string, { column: string }> = {
  HKQuantityTypeIdentifierRestingHeartRate: { column: "resting_hr" },
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: { column: "hrv" },
  HKQuantityTypeIdentifierVO2Max: { column: "vo2max" },
  HKQuantityTypeIdentifierWalkingSpeed: { column: "walking_speed" },
  HKQuantityTypeIdentifierWalkingStepLength: { column: "walking_step_length" },
  HKQuantityTypeIdentifierWalkingDoubleSupportPercentage: { column: "walking_double_support_pct" },
  HKQuantityTypeIdentifierWalkingAsymmetryPercentage: { column: "walking_asymmetry_pct" },
};

/** Metric stream types and their column names */
const metricStreamTypes: Record<string, { column: string }> = {
  HKQuantityTypeIdentifierHeartRate: { column: "heart_rate" },
  HKQuantityTypeIdentifierOxygenSaturation: { column: "spo2" },
  HKQuantityTypeIdentifierRespiratoryRate: { column: "respiratory_rate" },
  HKQuantityTypeIdentifierBloodGlucose: { column: "blood_glucose" },
  HKQuantityTypeIdentifierEnvironmentalAudioExposure: { column: "audio_exposure" },
  HKQuantityTypeIdentifierAppleSleepingWristTemperature: { column: "skin_temperature" },
};

/** HKWorkoutActivityType raw values to activity type strings */
const workoutActivityTypeMap: Record<string, string> = {
  "1": "americanFootball",
  "2": "archery",
  "3": "australianFootball",
  "4": "badminton",
  "5": "baseball",
  "6": "basketball",
  "7": "bowling",
  "8": "boxing",
  "9": "climbing",
  "10": "cricket",
  "11": "crossTraining",
  "12": "curling",
  "13": "cycling",
  "14": "dance",
  "15": "elliptical",
  "16": "equestrianSports",
  "17": "fencing",
  "18": "fishing",
  "19": "functionalStrengthTraining",
  "20": "golf",
  "21": "gymnastics",
  "22": "handball",
  "23": "hiking",
  "24": "hockey",
  "25": "hunting",
  "26": "lacrosse",
  "27": "martialArts",
  "28": "mindAndBody",
  "29": "paddleSports",
  "30": "play",
  "31": "preparationAndRecovery",
  "32": "racquetball",
  "33": "rowing",
  "34": "rugby",
  "35": "running",
  "36": "sailing",
  "37": "running",
  "38": "snowSports",
  "39": "soccer",
  "40": "softball",
  "41": "squash",
  "42": "stairClimbing",
  "43": "surfingSports",
  "44": "swimming",
  "45": "tableTennis",
  "46": "swimming",
  "47": "tennis",
  "48": "trackAndField",
  "49": "traditionalStrengthTraining",
  "50": "volleyball",
  "51": "walking",
  "52": "walking",
  "53": "waterFitness",
  "54": "waterPolo",
  "55": "waterSports",
  "56": "wrestling",
  "57": "yoga",
  "58": "barre",
  "59": "coreTraining",
  "60": "crossCountrySkiing",
  "61": "downhillSkiing",
  "62": "flexibility",
  "63": "highIntensityIntervalTraining",
  "64": "jumpRope",
  "65": "kickboxing",
  "66": "pilates",
  "67": "snowboarding",
  "68": "stairs",
  "69": "stepTraining",
  "70": "wheelchairWalkPace",
  "71": "wheelchairRunPace",
  "72": "taiChi",
  "73": "mixedCardio",
  "74": "handCycling",
  "75": "discSports",
  "76": "fitnessGaming",
  "77": "cardioDance",
  "78": "socialDance",
  "79": "pickleball",
  "80": "cooldown",
};

type Database = Parameters<Parameters<typeof protectedProcedure.mutation>[0]>[0]["ctx"]["db"];

/** Ensure the apple_health provider row exists */
async function ensureProvider(db: Database) {
  await db.execute(
    sql`INSERT INTO fitness.provider (id, name)
        VALUES (${PROVIDER_ID}, 'Apple Health')
        ON CONFLICT (id) DO NOTHING`,
  );
}

/** Extract date string (YYYY-MM-DD) from an ISO timestamp */
function extractDate(isoString: string): string {
  return isoString.slice(0, 10);
}

function computeBoundsFromIsoTimestamps(
  timestamps: string[],
): { startAt: string; endAt: string } | null {
  if (timestamps.length === 0) return null;

  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = Number.NEGATIVE_INFINITY;
  for (const ts of timestamps) {
    const ms = Date.parse(ts);
    if (Number.isNaN(ms)) continue;
    if (ms < minTs) minTs = ms;
    if (ms > maxTs) maxTs = ms;
  }

  if (!Number.isFinite(minTs) || !Number.isFinite(maxTs)) return null;
  return {
    startAt: new Date(minTs).toISOString(),
    endAt: new Date(maxTs).toISOString(),
  };
}

function parseIsoTimestamp(value: string): number | null {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) return null;
  return milliseconds;
}

function isSleepStageValue(value: string): boolean {
  return (
    value === "asleep" ||
    value === "asleepUnspecified" ||
    value === "asleepCore" ||
    value === "asleepDeep" ||
    value === "asleepREM"
  );
}

function deriveSleepSessionsFromStages(samples: SleepSample[]): SleepSample[] {
  const sessions: SleepSample[] = [];
  const bySource = new Map<string, SleepSample[]>();

  for (const sample of samples) {
    if (!isSleepStageValue(sample.value) && sample.value !== "awake") continue;
    const sourceSamples = bySource.get(sample.sourceName) ?? [];
    sourceSamples.push(sample);
    bySource.set(sample.sourceName, sourceSamples);
  }

  for (const [sourceName, sourceSamples] of bySource) {
    const sorted = sourceSamples
      .map((sample) => ({
        sample,
        startMs: parseIsoTimestamp(sample.startDate),
        endMs: parseIsoTimestamp(sample.endDate),
      }))
      .filter((entry): entry is { sample: SleepSample; startMs: number; endMs: number } => {
        if (entry.startMs === null || entry.endMs === null) return false;
        return entry.endMs > entry.startMs;
      })
      .sort((a, b) => a.startMs - b.startMs);

    if (sorted.length === 0) continue;

    const firstEntry = sorted[0];
    if (!firstEntry) continue;

    let currentStart = firstEntry.startMs;
    let currentEnd = firstEntry.endMs;
    let currentUuid = firstEntry.sample.uuid;
    let currentHasSleepStage = isSleepStageValue(firstEntry.sample.value);

    for (let index = 1; index < sorted.length; index++) {
      const entry = sorted[index];
      if (!entry) continue;

      if (entry.startMs <= currentEnd + MAX_SLEEP_SESSION_GAP_MS) {
        if (entry.endMs > currentEnd) {
          currentEnd = entry.endMs;
        }
        if (isSleepStageValue(entry.sample.value)) {
          currentHasSleepStage = true;
        }
        continue;
      }

      if (currentHasSleepStage) {
        sessions.push({
          uuid: currentUuid,
          startDate: new Date(currentStart).toISOString(),
          endDate: new Date(currentEnd).toISOString(),
          value: "inBed",
          sourceName,
        });
      }

      currentStart = entry.startMs;
      currentEnd = entry.endMs;
      currentUuid = entry.sample.uuid;
      currentHasSleepStage = isSleepStageValue(entry.sample.value);
    }

    if (currentHasSleepStage) {
      sessions.push({
        uuid: currentUuid,
        startDate: new Date(currentStart).toISOString(),
        endDate: new Date(currentEnd).toISOString(),
        value: "inBed",
        sourceName,
      });
    }
  }

  return sessions;
}

async function linkUnassignedHeartRateToWorkouts(
  db: Database,
  userId: string,
  bounds?: { startAt?: string; endAt?: string },
): Promise<number> {
  const filters = [
    sql`ms.user_id = ${userId}`,
    sql`ms.provider_id = ${PROVIDER_ID}`,
    sql`ms.activity_id IS NULL`,
    sql`ms.heart_rate IS NOT NULL`,
  ];
  if (bounds?.startAt) filters.push(sql`ms.recorded_at >= ${bounds.startAt}::timestamptz`);
  if (bounds?.endAt) filters.push(sql`ms.recorded_at <= ${bounds.endAt}::timestamptz`);

  const linked = await db.execute(
    sql`UPDATE fitness.metric_stream ms
        SET activity_id = (
          SELECT a.id
          FROM fitness.activity a
          WHERE a.user_id = ${userId}
            AND a.provider_id = ${PROVIDER_ID}
            AND ms.recorded_at >= a.started_at
            AND ms.recorded_at <= a.ended_at
          ORDER BY a.started_at DESC
          LIMIT 1
        )
        WHERE ${sql.join(filters, sql` AND `)}
          AND EXISTS (
            SELECT 1
            FROM fitness.activity a
            WHERE a.user_id = ${userId}
              AND a.provider_id = ${PROVIDER_ID}
              AND ms.recorded_at >= a.started_at
              AND ms.recorded_at <= a.ended_at
          )
        RETURNING ms.recorded_at`,
  );

  return Array.isArray(linked) ? linked.length : 0;
}

/** Route a sample to its destination category */
function categorize(
  type: string,
):
  | "bodyMeasurement"
  | "additiveDailyMetric"
  | "pointInTimeDailyMetric"
  | "metricStream"
  | "healthEvent" {
  if (type in bodyMeasurementTypes) return "bodyMeasurement";
  if (type in additiveDailyMetricTypes) return "additiveDailyMetric";
  if (type in pointInTimeDailyMetricTypes) return "pointInTimeDailyMetric";
  if (type in metricStreamTypes) return "metricStream";
  return "healthEvent";
}

/** Process body measurement samples */
async function processBodyMeasurements(
  db: Database,
  userId: string,
  samples: HealthKitSample[],
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < samples.length; i += BATCH_SIZE) {
    const batch = samples.slice(i, i + BATCH_SIZE);
    for (const sample of batch) {
      const mapping = bodyMeasurementTypes[sample.type];
      if (!mapping) continue;
      const value = mapping.transform ? mapping.transform(sample.value) : sample.value;
      const externalId = `hk:${sample.uuid}`;

      await db.execute(
        sql`INSERT INTO fitness.body_measurement (user_id, provider_id, external_id, recorded_at, ${sql.identifier(mapping.column)})
            VALUES (${userId}, ${PROVIDER_ID}, ${externalId}, ${sample.startDate}::timestamptz, ${value})
            ON CONFLICT (provider_id, external_id) DO UPDATE
              SET ${sql.identifier(mapping.column)} = ${value}`,
      );
      inserted++;
    }
  }
  return inserted;
}

/** Aggregated daily metric values for a single date */
export interface DailyMetricAccumulator {
  steps: number;
  activeEnergyKcal: number;
  basalEnergyKcal: number;
  distanceKm: number;
  cyclingDistanceKm: number;
  flightsClimbed: number;
  exerciseMinutes: number;
  restingHr: number | null;
  hrv: number | null;
  vo2max: number | null;
  walkingSpeed: number | null;
  walkingStepLength: number | null;
  walkingDoubleSupportPct: number | null;
  walkingAsymmetryPct: number | null;
}

function createEmptyAccumulator(): DailyMetricAccumulator {
  return {
    steps: 0,
    activeEnergyKcal: 0,
    basalEnergyKcal: 0,
    distanceKm: 0,
    cyclingDistanceKm: 0,
    flightsClimbed: 0,
    exerciseMinutes: 0,
    restingHr: null,
    hrv: null,
    vo2max: null,
    walkingSpeed: null,
    walkingStepLength: null,
    walkingDoubleSupportPct: null,
    walkingAsymmetryPct: null,
  };
}

/** Column name to accumulator key mapping */
const columnToAccumulatorKey: Record<string, keyof DailyMetricAccumulator> = {
  steps: "steps",
  active_energy_kcal: "activeEnergyKcal",
  basal_energy_kcal: "basalEnergyKcal",
  distance_km: "distanceKm",
  cycling_distance_km: "cyclingDistanceKm",
  flights_climbed: "flightsClimbed",
  exercise_minutes: "exerciseMinutes",
  resting_hr: "restingHr",
  hrv: "hrv",
  vo2max: "vo2max",
  walking_speed: "walkingSpeed",
  walking_step_length: "walkingStepLength",
  walking_double_support_pct: "walkingDoubleSupportPct",
  walking_asymmetry_pct: "walkingAsymmetryPct",
};

/** Aggregate daily metrics per date. */
export function aggregateDailyMetricSamples(
  samples: HealthKitSample[],
): Map<string, DailyMetricAccumulator> {
  const byDate = new Map<string, DailyMetricAccumulator>();
  const heartRateVariabilitySamplesByDate = new Map<
    string,
    Array<{ value: number; startDate: string }>
  >();

  for (const sample of samples) {
    const dateStr = extractDate(sample.startDate);
    let accumulator = byDate.get(dateStr);
    if (!accumulator) {
      accumulator = createEmptyAccumulator();
      byDate.set(dateStr, accumulator);
    }

    const additiveMapping = additiveDailyMetricTypes[sample.type];
    if (additiveMapping) {
      const value = additiveMapping.transform
        ? additiveMapping.transform(sample.value)
        : sample.value;
      const key = columnToAccumulatorKey[additiveMapping.column];
      if (key) {
        (accumulator[key] as number) += value;
      }
      continue;
    }

    const pointMapping = pointInTimeDailyMetricTypes[sample.type];
    if (!pointMapping) continue;

    if (pointMapping.column === "hrv") {
      const daySamples = heartRateVariabilitySamplesByDate.get(dateStr) ?? [];
      daySamples.push({ value: sample.value, startDate: sample.startDate });
      heartRateVariabilitySamplesByDate.set(dateStr, daySamples);
      continue;
    }

    const key = columnToAccumulatorKey[pointMapping.column];
    if (key) {
      (accumulator[key] as number | null) = sample.value;
    }
  }

  // Select overnight HRV for each date using shared logic
  for (const [dateStr, heartRateVariabilitySamples] of heartRateVariabilitySamplesByDate) {
    const accumulator = byDate.get(dateStr);
    if (accumulator) {
      accumulator.hrv = selectDailyHeartRateVariability(heartRateVariabilitySamples);
    }
  }

  return byDate;
}

/** Process daily metric samples (both additive and point-in-time) */
async function processDailyMetrics(
  db: Database,
  userId: string,
  samples: HealthKitSample[],
): Promise<number> {
  const byDate = aggregateDailyMetricSamples(samples);

  // Upsert each date
  for (const [dateStr, accumulator] of byDate) {
    const setClauses: ReturnType<typeof sql>[] = [];
    const insertColumns: ReturnType<typeof sql>[] = [];
    const insertValues: ReturnType<typeof sql>[] = [];

    insertColumns.push(sql`date`);
    insertValues.push(sql`${dateStr}::date`);
    insertColumns.push(sql`provider_id`);
    insertValues.push(sql`${PROVIDER_ID}`);
    insertColumns.push(sql`user_id`);
    insertValues.push(sql`${userId}`);

    // Additive fields: replace with the complete day-total from this sync.
    // Each iOS sync sends all samples for the 7-day window, so the in-memory
    // accumulator already contains the full sum — no need to add to existing.
    const additiveFields: Array<{ column: string; key: keyof DailyMetricAccumulator }> = [
      { column: "steps", key: "steps" },
      { column: "active_energy_kcal", key: "activeEnergyKcal" },
      { column: "basal_energy_kcal", key: "basalEnergyKcal" },
      { column: "distance_km", key: "distanceKm" },
      { column: "cycling_distance_km", key: "cyclingDistanceKm" },
      { column: "flights_climbed", key: "flightsClimbed" },
      { column: "exercise_minutes", key: "exerciseMinutes" },
    ];

    for (const { column, key } of additiveFields) {
      const value = Number(accumulator[key]);
      if (value > 0) {
        insertColumns.push(sql`${sql.identifier(column)}`);
        insertValues.push(sql`${value}`);
        setClauses.push(sql`${sql.identifier(column)} = EXCLUDED.${sql.identifier(column)}`);
      }
    }

    // Point-in-time fields: overwrite with aggregated day values (HRV is day-averaged upstream)
    const pointFields: Array<{ column: string; key: keyof DailyMetricAccumulator }> = [
      { column: "resting_hr", key: "restingHr" },
      { column: "hrv", key: "hrv" },
      { column: "vo2max", key: "vo2max" },
      { column: "walking_speed", key: "walkingSpeed" },
      { column: "walking_step_length", key: "walkingStepLength" },
      { column: "walking_double_support_pct", key: "walkingDoubleSupportPct" },
      { column: "walking_asymmetry_pct", key: "walkingAsymmetryPct" },
    ];

    for (const { column, key } of pointFields) {
      const value = accumulator[key];
      if (value !== null) {
        insertColumns.push(sql`${sql.identifier(column)}`);
        insertValues.push(sql`${value}`);
        setClauses.push(sql`${sql.identifier(column)} = EXCLUDED.${sql.identifier(column)}`);
      }
    }

    if (setClauses.length === 0) continue;

    const columnsSql = sql.join(insertColumns, sql`, `);
    const valuesSql = sql.join(insertValues, sql`, `);
    const setSql = sql.join(setClauses, sql`, `);

    await db.execute(
      sql`INSERT INTO fitness.daily_metrics (${columnsSql})
          VALUES (${valuesSql})
          ON CONFLICT (date, provider_id) DO UPDATE SET ${setSql}`,
    );
  }

  return samples.length;
}

/** Process metric stream samples */
async function processMetricStream(
  db: Database,
  userId: string,
  samples: HealthKitSample[],
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < samples.length; i += BATCH_SIZE) {
    const batch = samples.slice(i, i + BATCH_SIZE);
    for (const sample of batch) {
      const mapping = metricStreamTypes[sample.type];
      if (!mapping) continue;

      await db.execute(
        sql`INSERT INTO fitness.metric_stream (user_id, provider_id, recorded_at, ${sql.identifier(mapping.column)}, raw)
            VALUES (
              ${userId},
              ${PROVIDER_ID},
              ${sample.startDate}::timestamptz,
              ${sample.value},
              ${JSON.stringify({ uuid: sample.uuid, type: sample.type, sourceName: sample.sourceName })}::jsonb
            )`,
      );
      inserted++;
    }
  }
  return inserted;
}

/** Process health event samples (catch-all) */
async function processHealthEvents(
  db: Database,
  userId: string,
  samples: HealthKitSample[],
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < samples.length; i += BATCH_SIZE) {
    const batch = samples.slice(i, i + BATCH_SIZE);
    for (const sample of batch) {
      const externalId = `hk:${sample.uuid}`;
      await db.execute(
        sql`INSERT INTO fitness.health_event (user_id, provider_id, external_id, type, value, unit, source_name, start_date, end_date)
            VALUES (${userId}, ${PROVIDER_ID}, ${externalId}, ${sample.type}, ${sample.value}, ${sample.unit}, ${sample.sourceName}, ${sample.startDate}::timestamptz, ${sample.endDate}::timestamptz)
            ON CONFLICT (provider_id, external_id) DO NOTHING`,
      );
      inserted++;
    }
  }
  return inserted;
}

/** Process workout samples */
async function processWorkouts(
  db: Database,
  userId: string,
  workouts: WorkoutSample[],
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < workouts.length; i += BATCH_SIZE) {
    const batch = workouts.slice(i, i + BATCH_SIZE);
    for (const workout of batch) {
      const externalId = `hk:workout:${workout.uuid}`;
      const activityType = workoutActivityTypeMap[workout.workoutType] ?? "other";

      const rawData = JSON.stringify({
        duration: workout.duration,
        totalEnergyBurned: workout.totalEnergyBurned,
        totalDistance: workout.totalDistance,
        sourceName: workout.sourceName,
        workoutType: workout.workoutType,
      });

      await db.execute(
        sql`INSERT INTO fitness.activity (user_id, provider_id, external_id, activity_type, started_at, ended_at, raw)
            VALUES (
              ${userId},
              ${PROVIDER_ID},
              ${externalId},
              ${activityType},
              ${workout.startDate}::timestamptz,
              ${workout.endDate}::timestamptz,
              ${rawData}::jsonb
            )
            ON CONFLICT (provider_id, external_id) DO UPDATE SET
              activity_type = ${activityType},
              started_at = ${workout.startDate}::timestamptz,
              ended_at = ${workout.endDate}::timestamptz`,
      );
      inserted++;
    }
  }

  if (workouts.length > 0) {
    const bounds = computeBoundsFromIsoTimestamps(
      workouts.flatMap((w) => [w.startDate, w.endDate]),
    );
    await linkUnassignedHeartRateToWorkouts(db, userId, bounds ?? undefined);
  }

  return inserted;
}

/** Process sleep samples, grouping by inBed boundaries */
async function processSleepSamples(
  db: Database,
  userId: string,
  samples: SleepSample[],
): Promise<number> {
  const explicitInBedSamples = samples.filter((s) => s.value === "inBed");
  const inBedSamples =
    explicitInBedSamples.length > 0 ? explicitInBedSamples : deriveSleepSessionsFromStages(samples);
  const stageSamples = samples.filter((s) => s.value !== "inBed");

  if (inBedSamples.length === 0) return 0;

  let inserted = 0;
  for (const session of inBedSamples) {
    const sessionStart = new Date(session.startDate).getTime();
    const sessionEnd = new Date(session.endDate).getTime();

    let deepMinutes = 0;
    let remMinutes = 0;
    let lightMinutes = 0;
    let awakeMinutes = 0;

    for (const stage of stageSamples) {
      const stageStart = new Date(stage.startDate).getTime();
      const stageEnd = new Date(stage.endDate).getTime();

      if (stageStart >= sessionStart && stageEnd <= sessionEnd) {
        const durationMinutes = Math.round((stageEnd - stageStart) / (1000 * 60));
        switch (stage.value) {
          case "asleep":
          case "asleepUnspecified":
            lightMinutes += durationMinutes;
            break;
          case "asleepDeep":
            deepMinutes += durationMinutes;
            break;
          case "asleepREM":
            remMinutes += durationMinutes;
            break;
          case "asleepCore":
            lightMinutes += durationMinutes;
            break;
          case "awake":
            awakeMinutes += durationMinutes;
            break;
        }
      }
    }

    const externalId = `hk:sleep:${session.uuid}`;
    const durationMinutes = Math.round((sessionEnd - sessionStart) / (1000 * 60));
    const totalSleepMinutes = deepMinutes + remMinutes + lightMinutes;
    const efficiencyPct =
      durationMinutes > 0 ? Math.round((totalSleepMinutes / durationMinutes) * 1000) / 10 : null;
    await db.execute(
      sql`INSERT INTO fitness.sleep_session (user_id, provider_id, external_id, started_at, ended_at, duration_minutes, deep_minutes, rem_minutes, light_minutes, awake_minutes, efficiency_pct, sleep_type)
          VALUES (
            ${userId},
            ${PROVIDER_ID},
            ${externalId},
            ${session.startDate}::timestamptz,
            ${session.endDate}::timestamptz,
            ${durationMinutes},
            ${deepMinutes},
            ${remMinutes},
            ${lightMinutes},
            ${awakeMinutes},
            ${efficiencyPct},
            ${null}
          )
          ON CONFLICT (provider_id, external_id) DO UPDATE SET
            started_at = ${session.startDate}::timestamptz,
            ended_at = ${session.endDate}::timestamptz,
            duration_minutes = ${durationMinutes},
            deep_minutes = ${deepMinutes},
            rem_minutes = ${remMinutes},
            light_minutes = ${lightMinutes},
            awake_minutes = ${awakeMinutes},
            efficiency_pct = ${efficiencyPct},
            sleep_type = ${null}`,
    );
    inserted++;
  }

  return inserted;
}

/**
 * Aggregate SpO2 readings from metric_stream into daily_metrics.spo2_avg.
 * Apple Health stores SpO2 as fractions (0-1) in metric_stream; this converts
 * the daily average to a percentage (0-100) for consistency with other providers
 * (WHOOP, Oura, Garmin) that report SpO2 as a percentage.
 */
async function aggregateSpO2ToDailyMetrics(
  db: Database,
  userId: string,
  bounds: { startAt: string; endAt: string },
): Promise<void> {
  await db.execute(
    sql`INSERT INTO fitness.daily_metrics (date, provider_id, user_id, spo2_avg)
        SELECT
          (recorded_at AT TIME ZONE 'UTC')::date AS date,
          provider_id,
          user_id,
          AVG(spo2) * 100 AS spo2_avg
        FROM fitness.metric_stream
        WHERE provider_id = ${PROVIDER_ID}
          AND user_id = ${userId}
          AND spo2 IS NOT NULL
          AND recorded_at >= ${bounds.startAt}::timestamptz
          AND recorded_at <= ${bounds.endAt}::timestamptz
        GROUP BY (recorded_at AT TIME ZONE 'UTC')::date, provider_id, user_id
        ON CONFLICT (date, provider_id) DO UPDATE SET
          spo2_avg = EXCLUDED.spo2_avg`,
  );
}

/**
 * Aggregate wrist temperature readings from metric_stream into daily_metrics.skin_temp_c.
 * Apple Watch reports sleeping wrist temperature in °C; this computes the daily
 * average and stores it alongside other daily metrics.
 */
async function aggregateSkinTempToDailyMetrics(
  db: Database,
  userId: string,
  bounds: { startAt: string; endAt: string },
): Promise<void> {
  await db.execute(
    sql`INSERT INTO fitness.daily_metrics (date, provider_id, user_id, skin_temp_c)
        SELECT
          (recorded_at AT TIME ZONE 'UTC')::date AS date,
          provider_id,
          user_id,
          AVG(skin_temperature) AS skin_temp_c
        FROM fitness.metric_stream
        WHERE provider_id = ${PROVIDER_ID}
          AND user_id = ${userId}
          AND skin_temperature IS NOT NULL
          AND recorded_at >= ${bounds.startAt}::timestamptz
          AND recorded_at <= ${bounds.endAt}::timestamptz
        GROUP BY (recorded_at AT TIME ZONE 'UTC')::date, provider_id, user_id
        ON CONFLICT (date, provider_id) DO UPDATE SET
          skin_temp_c = EXCLUDED.skin_temp_c`,
  );
}

// ── Router ──

export const healthKitSyncRouter = router({
  pushQuantitySamples: protectedProcedure
    .input(z.object({ samples: z.array(healthKitSampleSchema) }))
    .mutation(async ({ ctx, input }) => {
      await ensureProvider(ctx.db);

      const bodyMeasurements: HealthKitSample[] = [];
      const dailyMetricSamples: HealthKitSample[] = [];
      const metricStreamSamples: HealthKitSample[] = [];
      const healthEventSamples: HealthKitSample[] = [];

      for (const sample of input.samples) {
        const category = categorize(sample.type);
        switch (category) {
          case "bodyMeasurement":
            bodyMeasurements.push(sample);
            break;
          case "additiveDailyMetric":
          case "pointInTimeDailyMetric":
            dailyMetricSamples.push(sample);
            break;
          case "metricStream":
            metricStreamSamples.push(sample);
            break;
          case "healthEvent":
            healthEventSamples.push(sample);
            break;
        }
      }

      let inserted = 0;
      const errors: string[] = [];

      try {
        inserted += await processBodyMeasurements(ctx.db, ctx.userId, bodyMeasurements);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Body measurements: ${message}`);
      }

      try {
        inserted += await processDailyMetrics(ctx.db, ctx.userId, dailyMetricSamples);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Daily metrics: ${message}`);
      }

      try {
        inserted += await processMetricStream(ctx.db, ctx.userId, metricStreamSamples);
        if (metricStreamSamples.length > 0) {
          const bounds = computeBoundsFromIsoTimestamps(
            metricStreamSamples.map((s) => s.startDate),
          );
          await linkUnassignedHeartRateToWorkouts(ctx.db, ctx.userId, bounds ?? undefined);

          // Aggregate SpO2 and skin temperature from metric_stream into daily_metrics
          let aggregatedDailyMetrics = false;
          if (bounds) {
            const hasSpo2 = metricStreamSamples.some(
              (s) => s.type === "HKQuantityTypeIdentifierOxygenSaturation",
            );
            if (hasSpo2) {
              await aggregateSpO2ToDailyMetrics(ctx.db, ctx.userId, bounds);
              aggregatedDailyMetrics = true;
            }
            const skinTempSamples = metricStreamSamples.filter(
              (s) => s.type === "HKQuantityTypeIdentifierAppleSleepingWristTemperature",
            );
            if (skinTempSamples.length > 0) {
              logger.info(
                `[apple_health] Received ${skinTempSamples.length} skin temperature samples, aggregating to daily_metrics`,
              );
              await aggregateSkinTempToDailyMetrics(ctx.db, ctx.userId, bounds);
              aggregatedDailyMetrics = true;
            }
          }

          // Refresh the daily metrics view so the dashboard picks up new data immediately
          if (aggregatedDailyMetrics) {
            try {
              await ctx.db.execute(
                sql.raw("REFRESH MATERIALIZED VIEW CONCURRENTLY fitness.v_daily_metrics"),
              );
            } catch {
              await ctx.db.execute(sql.raw("REFRESH MATERIALIZED VIEW fitness.v_daily_metrics"));
            }
          }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Metric stream: ${message}`);
      }

      try {
        inserted += await processHealthEvents(ctx.db, ctx.userId, healthEventSamples);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Health events: ${message}`);
      }

      return { inserted, errors };
    }),

  pushWorkouts: protectedProcedure
    .input(z.object({ workouts: z.array(workoutSampleSchema) }))
    .mutation(async ({ ctx, input }) => {
      await ensureProvider(ctx.db);
      const inserted = await processWorkouts(ctx.db, ctx.userId, input.workouts);
      return { inserted };
    }),

  pushSleepSamples: protectedProcedure
    .input(z.object({ samples: z.array(sleepSampleSchema) }))
    .mutation(async ({ ctx, input }) => {
      await ensureProvider(ctx.db);
      const inserted = await processSleepSamples(ctx.db, ctx.userId, input.samples);
      return { inserted };
    }),
});
