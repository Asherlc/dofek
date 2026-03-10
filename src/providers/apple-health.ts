import type { Provider, SyncResult, SyncError } from "./types.js";
import type { Database } from "../db/index.js";
import { bodyMeasurement, cardioActivity, metricStream, dailyMetrics, sleepSession } from "../db/schema.js";
import { ensureProvider } from "../db/tokens.js";
import sax from "sax";
import { createReadStream, readdirSync, statSync } from "fs";
import { join } from "path";

// ============================================================
// Apple Health date parsing
// ============================================================

/**
 * Parse Apple Health date format: "2024-03-01 10:30:00 -0500"
 * Convert to ISO 8601 so Date() can handle it.
 */
export function parseHealthDate(dateStr: string): Date {
  // "2024-03-01 10:30:00 -0500" → "2024-03-01T10:30:00-05:00"
  const match = dateStr.match(
    /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([+-]\d{2})(\d{2})$/,
  );
  if (!match) {
    return new Date(dateStr); // fallback
  }
  return new Date(`${match[1]}T${match[2]}${match[3]}:${match[4]}`);
}

// ============================================================
// Record parsing
// ============================================================

export interface HealthRecord {
  type: string;
  sourceName: string;
  unit: string;
  value: number;
  startDate: Date;
  endDate: Date;
  creationDate: Date;
}

export function parseRecord(attrs: Record<string, string>): HealthRecord | null {
  const type = attrs.type;
  const value = parseFloat(attrs.value);
  if (!type || isNaN(value)) return null;

  return {
    type,
    sourceName: attrs.sourceName ?? "",
    unit: attrs.unit ?? "",
    value,
    startDate: parseHealthDate(attrs.startDate),
    endDate: parseHealthDate(attrs.endDate),
    creationDate: parseHealthDate(attrs.creationDate),
  };
}

// ============================================================
// Sleep analysis parsing
// ============================================================

export type SleepStage = "inBed" | "core" | "deep" | "rem" | "awake" | "asleep";

export interface SleepAnalysisRecord {
  stage: SleepStage;
  sourceName: string;
  startDate: Date;
  endDate: Date;
  durationMinutes: number;
}

const SLEEP_STAGE_MAP: Record<string, SleepStage> = {
  HKCategoryValueSleepAnalysisInBed: "inBed",
  HKCategoryValueSleepAnalysisAsleepCore: "core",
  HKCategoryValueSleepAnalysisAsleepDeep: "deep",
  HKCategoryValueSleepAnalysisAsleepREM: "rem",
  HKCategoryValueSleepAnalysisAwake: "awake",
  HKCategoryValueSleepAnalysisAsleepUnspecified: "asleep",
  // Legacy numeric values (iOS < 16)
  "0": "inBed",
  "1": "asleep",
  "2": "awake",
};

export function parseSleepAnalysis(attrs: Record<string, string>): SleepAnalysisRecord | null {
  const stage = SLEEP_STAGE_MAP[attrs.value];
  if (!stage) return null;

  const startDate = parseHealthDate(attrs.startDate);
  const endDate = parseHealthDate(attrs.endDate);
  const durationMinutes = Math.round((endDate.getTime() - startDate.getTime()) / 60000);

  return {
    stage,
    sourceName: attrs.sourceName ?? "",
    startDate,
    endDate,
    durationMinutes,
  };
}

// ============================================================
// Workout parsing
// ============================================================

export interface HealthWorkout {
  activityType: string;
  sourceName: string;
  durationSeconds: number;
  distanceMeters?: number;
  calories?: number;
  startDate: Date;
  endDate: Date;
}

// Map HKWorkoutActivityType* to normalized lowercase names
const WORKOUT_TYPE_MAP: Record<string, string> = {
  HKWorkoutActivityTypeAmericanFootball: "american_football",
  HKWorkoutActivityTypeArchery: "archery",
  HKWorkoutActivityTypeAustralianFootball: "australian_football",
  HKWorkoutActivityTypeBadminton: "badminton",
  HKWorkoutActivityTypeBaseball: "baseball",
  HKWorkoutActivityTypeBasketball: "basketball",
  HKWorkoutActivityTypeBowling: "bowling",
  HKWorkoutActivityTypeBoxing: "boxing",
  HKWorkoutActivityTypeClimbing: "climbing",
  HKWorkoutActivityTypeCricket: "cricket",
  HKWorkoutActivityTypeCrossCountrySkiing: "cross_country_skiing",
  HKWorkoutActivityTypeCrossTraining: "cross_training",
  HKWorkoutActivityTypeCurling: "curling",
  HKWorkoutActivityTypeCycling: "cycling",
  HKWorkoutActivityTypeDance: "dance",
  HKWorkoutActivityTypeDownhillSkiing: "downhill_skiing",
  HKWorkoutActivityTypeElliptical: "elliptical",
  HKWorkoutActivityTypeEquestrianSports: "equestrian",
  HKWorkoutActivityTypeFencing: "fencing",
  HKWorkoutActivityTypeFishing: "fishing",
  HKWorkoutActivityTypeFunctionalStrengthTraining: "functional_strength",
  HKWorkoutActivityTypeGolf: "golf",
  HKWorkoutActivityTypeGymnastics: "gymnastics",
  HKWorkoutActivityTypeHandball: "handball",
  HKWorkoutActivityTypeHiking: "hiking",
  HKWorkoutActivityTypeHockey: "hockey",
  HKWorkoutActivityTypeHunting: "hunting",
  HKWorkoutActivityTypeLacrosse: "lacrosse",
  HKWorkoutActivityTypeMartialArts: "martial_arts",
  HKWorkoutActivityTypeMindAndBody: "mind_and_body",
  HKWorkoutActivityTypeMixedCardio: "mixed_cardio",
  HKWorkoutActivityTypePaddleSports: "paddle_sports",
  HKWorkoutActivityTypePlay: "play",
  HKWorkoutActivityTypePreparationAndRecovery: "preparation_and_recovery",
  HKWorkoutActivityTypeRacquetball: "racquetball",
  HKWorkoutActivityTypeRowing: "rowing",
  HKWorkoutActivityTypeRugby: "rugby",
  HKWorkoutActivityTypeRunning: "running",
  HKWorkoutActivityTypeSailing: "sailing",
  HKWorkoutActivityTypeSkatingSports: "skating",
  HKWorkoutActivityTypeSnowSports: "snow_sports",
  HKWorkoutActivityTypeSoccer: "soccer",
  HKWorkoutActivityTypeSoftball: "softball",
  HKWorkoutActivityTypeSquash: "squash",
  HKWorkoutActivityTypeStairClimbing: "stair_climbing",
  HKWorkoutActivityTypeSurfingSports: "surfing",
  HKWorkoutActivityTypeSwimming: "swimming",
  HKWorkoutActivityTypeTableTennis: "table_tennis",
  HKWorkoutActivityTypeTennis: "tennis",
  HKWorkoutActivityTypeTrackAndField: "track_and_field",
  HKWorkoutActivityTypeTraditionalStrengthTraining: "strength_training",
  HKWorkoutActivityTypeVolleyball: "volleyball",
  HKWorkoutActivityTypeWalking: "walking",
  HKWorkoutActivityTypeWaterFitness: "water_fitness",
  HKWorkoutActivityTypeWaterPolo: "water_polo",
  HKWorkoutActivityTypeWaterSports: "water_sports",
  HKWorkoutActivityTypeWrestling: "wrestling",
  HKWorkoutActivityTypeYoga: "yoga",
  HKWorkoutActivityTypeBarre: "barre",
  HKWorkoutActivityTypeCoreTraining: "core_training",
  HKWorkoutActivityTypeFlexibility: "flexibility",
  HKWorkoutActivityTypeHighIntensityIntervalTraining: "hiit",
  HKWorkoutActivityTypeJumpRope: "jump_rope",
  HKWorkoutActivityTypeKickboxing: "kickboxing",
  HKWorkoutActivityTypePilates: "pilates",
  HKWorkoutActivityTypeSnowboarding: "snowboarding",
  HKWorkoutActivityTypeStairs: "stairs",
  HKWorkoutActivityTypeStepTraining: "step_training",
  HKWorkoutActivityTypeWheelchairWalkPace: "wheelchair_walk",
  HKWorkoutActivityTypeWheelchairRunPace: "wheelchair_run",
  HKWorkoutActivityTypeTaiChi: "tai_chi",
  HKWorkoutActivityTypeMixedMetabolicCardioTraining: "mixed_metabolic_cardio",
  HKWorkoutActivityTypeHandCycling: "hand_cycling",
  HKWorkoutActivityTypeDiscSports: "disc_sports",
  HKWorkoutActivityTypeFitnessGaming: "fitness_gaming",
  HKWorkoutActivityTypeCardioDance: "cardio_dance",
  HKWorkoutActivityTypeSocialDance: "social_dance",
  HKWorkoutActivityTypePickleball: "paddle_racquet",
  HKWorkoutActivityTypeCooldown: "cooldown",
  HKWorkoutActivityTypeSwimBikeRun: "triathlon",
  HKWorkoutActivityTypeTransition: "transition",
  HKWorkoutActivityTypeUnderwaterDiving: "underwater_diving",
  HKWorkoutActivityTypeOther: "other",
};

function normalizeDuration(value: string, unit: string): number {
  const v = parseFloat(value);
  switch (unit) {
    case "min": return v * 60;
    case "hr": return v * 3600;
    default: return v; // assume seconds
  }
}

function normalizeDistance(value: string, unit: string): number {
  const v = parseFloat(value);
  switch (unit) {
    case "km": return v * 1000;
    case "mi": return v * 1609.344;
    default: return v; // assume meters
  }
}

export function parseWorkout(attrs: Record<string, string>): HealthWorkout {
  const rawType = attrs.workoutActivityType ?? "HKWorkoutActivityTypeOther";
  const activityType = WORKOUT_TYPE_MAP[rawType] ?? rawType.replace("HKWorkoutActivityType", "").toLowerCase();

  const durationSeconds = normalizeDuration(attrs.duration ?? "0", attrs.durationUnit ?? "min");

  let distanceMeters: number | undefined;
  if (attrs.totalDistance) {
    distanceMeters = normalizeDistance(attrs.totalDistance, attrs.totalDistanceUnit ?? "m");
  }

  let calories: number | undefined;
  if (attrs.totalEnergyBurned) {
    const raw = parseFloat(attrs.totalEnergyBurned);
    // Apple Health always reports in kcal
    calories = Math.round(raw);
  }

  return {
    activityType,
    sourceName: attrs.sourceName ?? "",
    durationSeconds,
    distanceMeters,
    calories,
    startDate: parseHealthDate(attrs.startDate),
    endDate: parseHealthDate(attrs.endDate),
  };
}

// ============================================================
// Streaming XML parser with batched callbacks
// ============================================================

export interface StreamCallbacks {
  onRecordBatch: (records: HealthRecord[]) => Promise<void>;
  onSleepBatch: (records: SleepAnalysisRecord[]) => Promise<void>;
  onWorkoutBatch: (workouts: HealthWorkout[]) => Promise<void>;
}

const BATCH_SIZE = 500;

/**
 * Stream-parse an Apple Health export.xml file.
 * Calls back in batches for constant memory usage on large (1GB+) files.
 * Only processes records with startDate >= since.
 */
export function streamHealthExport(
  filePath: string,
  since: Date,
  callbacks: StreamCallbacks,
): Promise<{ recordCount: number; workoutCount: number; sleepCount: number }> {
  return new Promise((resolve, reject) => {
    const parser = sax.createStream(true, { trim: true });
    let recordBatch: HealthRecord[] = [];
    let sleepBatch: SleepAnalysisRecord[] = [];
    let workoutBatch: HealthWorkout[] = [];
    let recordCount = 0;
    let workoutCount = 0;
    let sleepCount = 0;
    let pending = Promise.resolve();

    function enqueue(fn: () => Promise<void>) {
      pending = pending.then(fn);
    }

    parser.on("opentag", (node) => {
      if (node.name === "Record") {
        const attrs = node.attributes as Record<string, string>;

        if (attrs.type === "HKCategoryTypeIdentifierSleepAnalysis") {
          const sleep = parseSleepAnalysis(attrs);
          if (sleep && sleep.startDate >= since) {
            sleepBatch.push(sleep);
            sleepCount++;
            if (sleepBatch.length >= BATCH_SIZE) {
              const batch = sleepBatch;
              sleepBatch = [];
              enqueue(() => callbacks.onSleepBatch(batch));
            }
          }
        } else {
          const record = parseRecord(attrs);
          if (record && record.startDate >= since) {
            recordBatch.push(record);
            recordCount++;
            if (recordBatch.length >= BATCH_SIZE) {
              const batch = recordBatch;
              recordBatch = [];
              enqueue(() => callbacks.onRecordBatch(batch));
            }
          }
        }
      } else if (node.name === "Workout") {
        const workout = parseWorkout(node.attributes as Record<string, string>);
        if (workout.startDate >= since) {
          workoutBatch.push(workout);
          workoutCount++;
          if (workoutBatch.length >= BATCH_SIZE) {
            const batch = workoutBatch;
            workoutBatch = [];
            enqueue(() => callbacks.onWorkoutBatch(batch));
          }
        }
      }
    });

    parser.on("error", (err) => reject(err));
    parser.on("end", () => {
      // Flush remaining batches
      if (recordBatch.length > 0) enqueue(() => callbacks.onRecordBatch(recordBatch));
      if (sleepBatch.length > 0) enqueue(() => callbacks.onSleepBatch(sleepBatch));
      if (workoutBatch.length > 0) enqueue(() => callbacks.onWorkoutBatch(workoutBatch));

      pending
        .then(() => resolve({ recordCount, workoutCount, sleepCount }))
        .catch(reject);
    });

    createReadStream(filePath, { encoding: "utf8" }).pipe(parser);
  });
}

// ============================================================
// Record type → DB table routing
// ============================================================

// Records that map to metric_stream (granular time-series)
const METRIC_STREAM_TYPES: Record<string, string> = {
  HKQuantityTypeIdentifierHeartRate: "heartRate",
  HKQuantityTypeIdentifierOxygenSaturation: "spo2",
  HKQuantityTypeIdentifierRespiratoryRate: "respiratoryRate",
};

// Records that map to body_measurement
const BODY_MEASUREMENT_TYPES = new Set([
  "HKQuantityTypeIdentifierBodyMass",
  "HKQuantityTypeIdentifierBodyFatPercentage",
  "HKQuantityTypeIdentifierBodyMassIndex",
  "HKQuantityTypeIdentifierLeanBodyMass",
  "HKQuantityTypeIdentifierBloodPressureSystolic",
  "HKQuantityTypeIdentifierBloodPressureDiastolic",
  "HKQuantityTypeIdentifierBodyTemperature",
]);

// Records that map to daily_metrics (one value per day)
const DAILY_METRIC_TYPES = new Set([
  "HKQuantityTypeIdentifierRestingHeartRate",
  "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
  "HKQuantityTypeIdentifierVO2Max",
  "HKQuantityTypeIdentifierStepCount",
  "HKQuantityTypeIdentifierActiveEnergyBurned",
  "HKQuantityTypeIdentifierBasalEnergyBurned",
]);

function dateToString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ============================================================
// DB insertion helpers
// ============================================================

async function upsertMetricStreamBatch(
  db: Database,
  providerId: string,
  records: HealthRecord[],
): Promise<number> {
  let count = 0;
  for (const record of records) {
    const field = METRIC_STREAM_TYPES[record.type];
    if (!field) continue;

    const row: Record<string, unknown> = {
      providerId,
      recordedAt: record.startDate,
    };

    if (field === "heartRate") row.heartRate = Math.round(record.value);
    else if (field === "spo2") row.spo2 = record.value;
    else if (field === "respiratoryRate") row.respiratoryRate = record.value;

    await db.insert(metricStream).values(row as typeof metricStream.$inferInsert);
    count++;
  }
  return count;
}

async function upsertBodyMeasurementBatch(
  db: Database,
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

  let count = 0;
  for (const [, group] of byTime) {
    const first = group[0];
    const externalId = `ah:body:${first.startDate.toISOString()}`;
    const row: Record<string, unknown> = {
      providerId,
      externalId,
      recordedAt: first.startDate,
    };

    for (const r of group) {
      switch (r.type) {
        case "HKQuantityTypeIdentifierBodyMass": row.weightKg = r.value; break;
        case "HKQuantityTypeIdentifierBodyFatPercentage": row.bodyFatPct = r.value * 100; break;
        case "HKQuantityTypeIdentifierBodyMassIndex": row.bmi = r.value; break;
        case "HKQuantityTypeIdentifierBloodPressureSystolic": row.systolicBp = Math.round(r.value); break;
        case "HKQuantityTypeIdentifierBloodPressureDiastolic": row.diastolicBp = Math.round(r.value); break;
        case "HKQuantityTypeIdentifierBodyTemperature": row.temperatureC = r.value; break;
      }
    }

    await db.insert(bodyMeasurement).values(row as typeof bodyMeasurement.$inferInsert)
      .onConflictDoUpdate({
        target: [bodyMeasurement.providerId, bodyMeasurement.externalId],
        set: row as Record<string, unknown>,
      });
    count++;
  }
  return count;
}

async function upsertDailyMetricsBatch(
  db: Database,
  providerId: string,
  records: HealthRecord[],
): Promise<number> {
  // Aggregate by date — sum steps/energy, take latest for point-in-time values
  const byDate = new Map<string, Map<string, number>>();
  for (const r of records) {
    if (!DAILY_METRIC_TYPES.has(r.type)) continue;
    const dateKey = dateToString(r.startDate);
    if (!byDate.has(dateKey)) byDate.set(dateKey, new Map());
    const day = byDate.get(dateKey)!;

    // Additive metrics get summed
    if (r.type === "HKQuantityTypeIdentifierStepCount" ||
        r.type === "HKQuantityTypeIdentifierActiveEnergyBurned" ||
        r.type === "HKQuantityTypeIdentifierBasalEnergyBurned") {
      day.set(r.type, (day.get(r.type) ?? 0) + r.value);
    } else {
      // Point-in-time: keep latest
      day.set(r.type, r.value);
    }
  }

  let count = 0;
  for (const [dateKey, metrics] of byDate) {
    const row: Record<string, unknown> = {
      date: dateKey,
      providerId,
      sport: "all",
    };

    for (const [type, value] of metrics) {
      switch (type) {
        case "HKQuantityTypeIdentifierRestingHeartRate": row.restingHr = Math.round(value); break;
        case "HKQuantityTypeIdentifierHeartRateVariabilitySDNN": row.hrv = value; break;
        case "HKQuantityTypeIdentifierVO2Max": row.vo2max = value; break;
        case "HKQuantityTypeIdentifierStepCount": row.steps = Math.round(value); break;
        case "HKQuantityTypeIdentifierActiveEnergyBurned": row.activeEnergyKcal = value; break;
        case "HKQuantityTypeIdentifierBasalEnergyBurned": row.basalEnergyKcal = value; break;
      }
    }

    await db.insert(dailyMetrics).values(row as typeof dailyMetrics.$inferInsert)
      .onConflictDoUpdate({
        target: [dailyMetrics.date, dailyMetrics.providerId, dailyMetrics.sport],
        set: row as Record<string, unknown>,
      });
    count++;
  }
  return count;
}

async function upsertWorkoutBatch(
  db: Database,
  providerId: string,
  workouts: HealthWorkout[],
): Promise<number> {
  let count = 0;
  for (const w of workouts) {
    const externalId = `ah:workout:${w.startDate.toISOString()}`;
    await db.insert(cardioActivity).values({
      providerId,
      externalId,
      activityType: w.activityType,
      startedAt: w.startDate,
      endedAt: w.endDate,
      durationSeconds: Math.round(w.durationSeconds),
      distanceMeters: w.distanceMeters,
      calories: w.calories,
    }).onConflictDoUpdate({
      target: [cardioActivity.providerId, cardioActivity.externalId],
      set: {
        activityType: w.activityType,
        endedAt: w.endDate,
        durationSeconds: Math.round(w.durationSeconds),
        distanceMeters: w.distanceMeters,
        calories: w.calories,
      },
    });
    count++;
  }
  return count;
}

async function upsertSleepBatch(
  db: Database,
  providerId: string,
  records: SleepAnalysisRecord[],
): Promise<number> {
  // Group sleep segments into sessions by finding "inBed" spans
  // Each inBed record is one session; we aggregate stage durations within it
  const inBedRecords = records.filter((r) => r.stage === "inBed");
  const stageRecords = records.filter((r) => r.stage !== "inBed");

  let count = 0;
  for (const bed of inBedRecords) {
    // Find stages that overlap with this inBed period
    const stages = stageRecords.filter(
      (s) => s.startDate >= bed.startDate && s.endDate <= bed.endDate,
    );

    let deepMinutes = 0;
    let remMinutes = 0;
    let lightMinutes = 0;
    let awakeMinutes = 0;

    for (const s of stages) {
      switch (s.stage) {
        case "deep": deepMinutes += s.durationMinutes; break;
        case "rem": remMinutes += s.durationMinutes; break;
        case "core": lightMinutes += s.durationMinutes; break;
        case "awake": awakeMinutes += s.durationMinutes; break;
      }
    }

    const totalSleepMinutes = deepMinutes + remMinutes + lightMinutes;
    const externalId = `ah:sleep:${bed.startDate.toISOString()}`;
    const isNap = bed.durationMinutes < 120; // < 2 hours = nap

    await db.insert(sleepSession).values({
      providerId,
      externalId,
      startedAt: bed.startDate,
      endedAt: bed.endDate,
      durationMinutes: bed.durationMinutes,
      deepMinutes: deepMinutes || undefined,
      remMinutes: remMinutes || undefined,
      lightMinutes: lightMinutes || undefined,
      awakeMinutes: awakeMinutes || undefined,
      efficiencyPct: bed.durationMinutes > 0
        ? Math.round((totalSleepMinutes / bed.durationMinutes) * 100) / 100
        : undefined,
      isNap,
    }).onConflictDoUpdate({
      target: [sleepSession.providerId, sleepSession.externalId],
      set: {
        endedAt: bed.endDate,
        durationMinutes: bed.durationMinutes,
        deepMinutes: deepMinutes || undefined,
        remMinutes: remMinutes || undefined,
        lightMinutes: lightMinutes || undefined,
        awakeMinutes: awakeMinutes || undefined,
        isNap,
      },
    });
    count++;
  }
  return count;
}

// ============================================================
// Provider implementation
// ============================================================

export class AppleHealthProvider implements Provider {
  readonly id = "apple_health";
  readonly name = "Apple Health";

  validate(): string | null {
    const dir = process.env.APPLE_HEALTH_IMPORT_DIR;
    if (!dir) return "APPLE_HEALTH_IMPORT_DIR is not set";
    return null;
  }

  private findLatestExport(): string | null {
    const dir = process.env.APPLE_HEALTH_IMPORT_DIR;
    if (!dir) return null;

    try {
      const files = readdirSync(dir)
        .filter((f) => f.endsWith(".xml"))
        .map((f) => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);

      return files.length > 0 ? join(dir, files[0].name) : null;
    } catch {
      return null;
    }
  }

  async sync(db: Database, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    await ensureProvider(db, this.id, this.name);

    const filePath = this.findLatestExport();
    if (!filePath) {
      errors.push({ message: "No Apple Health export XML found in APPLE_HEALTH_IMPORT_DIR" });
      return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
    }

    console.log(`[apple_health] Importing from ${filePath}`);

    try {
      const counts = await streamHealthExport(filePath, since, {
        onRecordBatch: async (records) => {
          const metricRecords = records.filter((r) => METRIC_STREAM_TYPES[r.type]);
          const bodyRecords = records.filter((r) => BODY_MEASUREMENT_TYPES.has(r.type));
          const dailyRecords = records.filter((r) => DAILY_METRIC_TYPES.has(r.type));

          if (metricRecords.length > 0) {
            const c = await upsertMetricStreamBatch(db, this.id, metricRecords);
            recordsSynced += c;
          }
          if (bodyRecords.length > 0) {
            const c = await upsertBodyMeasurementBatch(db, this.id, bodyRecords);
            recordsSynced += c;
          }
          if (dailyRecords.length > 0) {
            const c = await upsertDailyMetricsBatch(db, this.id, dailyRecords);
            recordsSynced += c;
          }
        },
        onSleepBatch: async (records) => {
          const c = await upsertSleepBatch(db, this.id, records);
          recordsSynced += c;
        },
        onWorkoutBatch: async (workouts) => {
          const c = await upsertWorkoutBatch(db, this.id, workouts);
          recordsSynced += c;
        },
      });

      console.log(
        `[apple_health] Parsed ${counts.recordCount} records, ` +
        `${counts.workoutCount} workouts, ${counts.sleepCount} sleep records`,
      );
    } catch (err) {
      errors.push({
        message: err instanceof Error ? err.message : String(err),
        cause: err,
      });
    }

    return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
  }
}
