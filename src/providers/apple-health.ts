import type { Provider, SyncResult, SyncError } from "./types.js";
import type { Database } from "../db/index.js";
import { bodyMeasurement, cardioActivity, metricStream, dailyMetrics, sleepSession, labResult } from "../db/schema.js";
import { ensureProvider } from "../db/tokens.js";
import sax from "sax";
import yauzl from "yauzl";
import { createReadStream, createWriteStream, readdirSync, statSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

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
  avgHeartRate?: number;
  maxHeartRate?: number;
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

export interface ActivitySummary {
  date: string; // YYYY-MM-DD
  activeEnergyBurned?: number;
  appleExerciseMinutes?: number;
  appleStandHours?: number;
}

export function parseActivitySummary(attrs: Record<string, string>): ActivitySummary | null {
  const date = attrs.dateComponents;
  if (!date) return null;

  return {
    date,
    activeEnergyBurned: attrs.activeEnergyBurned ? parseFloat(attrs.activeEnergyBurned) : undefined,
    appleExerciseMinutes: attrs.appleExerciseTime ? parseFloat(attrs.appleExerciseTime) : undefined,
    appleStandHours: attrs.appleStandHours ? parseFloat(attrs.appleStandHours) : undefined,
  };
}

export interface WorkoutStatistics {
  type: string;
  sum?: number;
  average?: number;
  minimum?: number;
  maximum?: number;
  unit?: string;
}

export function parseWorkoutStatistics(attrs: Record<string, string>): WorkoutStatistics {
  return {
    type: attrs.type ?? "",
    sum: attrs.sum ? parseFloat(attrs.sum) : undefined,
    average: attrs.average ? parseFloat(attrs.average) : undefined,
    minimum: attrs.minimum ? parseFloat(attrs.minimum) : undefined,
    maximum: attrs.maximum ? parseFloat(attrs.maximum) : undefined,
    unit: attrs.unit,
  };
}

export function enrichWorkoutFromStats(workout: HealthWorkout, stats: WorkoutStatistics[]): void {
  for (const s of stats) {
    switch (s.type) {
      case "HKQuantityTypeIdentifierHeartRate":
        if (s.average !== undefined) workout.avgHeartRate = Math.round(s.average);
        if (s.maximum !== undefined) workout.maxHeartRate = Math.round(s.maximum);
        break;
      case "HKQuantityTypeIdentifierActiveEnergyBurned":
        if (s.sum !== undefined && workout.calories === undefined) {
          workout.calories = Math.round(s.sum);
        }
        break;
    }
  }
}

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
    const fileStream = createReadStream(filePath, { encoding: "utf8" });
    let recordBatch: HealthRecord[] = [];
    let sleepBatch: SleepAnalysisRecord[] = [];
    let workoutBatch: HealthWorkout[] = [];
    let recordCount = 0;
    let workoutCount = 0;
    let sleepCount = 0;
    let pendingFlushes = 0;

    // State for nested elements
    let currentWorkout: HealthWorkout | null = null;
    let currentWorkoutStats: WorkoutStatistics[] = [];

    // Backpressure: pause the file stream while DB writes are in progress.
    // Max concurrent flushes before we pause.
    const MAX_PENDING = 2;

    function trackFlush(fn: () => Promise<void>) {
      pendingFlushes++;
      if (pendingFlushes >= MAX_PENDING) {
        fileStream.pause();
      }
      fn().then(() => {
        pendingFlushes--;
        if (pendingFlushes < MAX_PENDING) {
          fileStream.resume();
        }
      }).catch((err) => {
        reject(err);
      });
    }

    function addRecord(record: HealthRecord) {
      recordBatch.push(record);
      recordCount++;
      if (recordBatch.length >= BATCH_SIZE) {
        const batch = recordBatch;
        recordBatch = [];
        trackFlush(() => callbacks.onRecordBatch(batch));
      }
    }

    function addSleep(sleep: SleepAnalysisRecord) {
      sleepBatch.push(sleep);
      sleepCount++;
      if (sleepBatch.length >= BATCH_SIZE) {
        const batch = sleepBatch;
        sleepBatch = [];
        trackFlush(() => callbacks.onSleepBatch(batch));
      }
    }

    function flushWorkout() {
      if (currentWorkout) {
        if (currentWorkoutStats.length > 0) {
          enrichWorkoutFromStats(currentWorkout, currentWorkoutStats);
        }
        workoutBatch.push(currentWorkout);
        workoutCount++;
        if (workoutBatch.length >= BATCH_SIZE) {
          const batch = workoutBatch;
          workoutBatch = [];
          trackFlush(() => callbacks.onWorkoutBatch(batch));
        }
      }
      currentWorkout = null;
      currentWorkoutStats = [];
    }

    parser.on("opentag", (node) => {
      const attrs = node.attributes as Record<string, string>;

      // Records appear at top level and inside Correlations (e.g. BP pairs)
      if (node.name === "Record") {
        // Records appear both at top level and inside Correlations
        if (attrs.type === "HKCategoryTypeIdentifierSleepAnalysis") {
          const sleep = parseSleepAnalysis(attrs);
          if (sleep && sleep.startDate >= since) addSleep(sleep);
        } else {
          const record = parseRecord(attrs);
          if (record && record.startDate >= since) addRecord(record);
        }
      } else if (node.name === "Workout") {
        const workout = parseWorkout(attrs);
        if (workout.startDate >= since) {
          currentWorkout = workout;
          currentWorkoutStats = [];
        }
      } else if (node.name === "WorkoutStatistics" && currentWorkout) {
        currentWorkoutStats.push(parseWorkoutStatistics(attrs));
      } else if (node.name === "ActivitySummary") {
        // ActivitySummary contains daily ring data — treat as a record batch
        const summary = parseActivitySummary(attrs);
        if (summary) {
          // Convert to HealthRecords for the daily metrics pipeline
          const date = parseHealthDate(`${summary.date} 00:00:00 +0000`);
          if (date >= since) {
            if (summary.activeEnergyBurned !== undefined) {
              addRecord({
                type: "HKQuantityTypeIdentifierActiveEnergyBurned",
                sourceName: "ActivitySummary",
                unit: "kcal",
                value: summary.activeEnergyBurned,
                startDate: date, endDate: date, creationDate: date,
              });
            }
          }
        }
      }
    });

    parser.on("closetag", (name) => {
      if (name === "Workout") {
        flushWorkout();
      }
    });

    parser.on("error", (err) => reject(err));
    parser.on("end", () => {
      // Flush any in-progress workout
      flushWorkout();

      // Flush remaining batches
      const finalFlushes: Promise<void>[] = [];
      if (recordBatch.length > 0) finalFlushes.push(callbacks.onRecordBatch(recordBatch));
      if (sleepBatch.length > 0) finalFlushes.push(callbacks.onSleepBatch(sleepBatch));
      if (workoutBatch.length > 0) finalFlushes.push(callbacks.onWorkoutBatch(workoutBatch));

      // Wait for all pending + final flushes
      const waitForPending = (): Promise<void> => {
        if (pendingFlushes > 0) {
          return new Promise<void>((res) => setTimeout(res, 50)).then(waitForPending);
        }
        return Promise.resolve();
      };

      waitForPending()
        .then(() => Promise.all(finalFlushes))
        .then(() => resolve({ recordCount, workoutCount, sleepCount }))
        .catch(reject);
    });

    fileStream.pipe(parser);
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
  const rows: (typeof metricStream.$inferInsert)[] = [];
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

    rows.push(row as typeof metricStream.$inferInsert);
  }

  if (rows.length > 0) {
    await db.insert(metricStream).values(rows);
  }
  return rows.length;
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
        target: [dailyMetrics.date, dailyMetrics.providerId],
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
      avgHeartRate: w.avgHeartRate,
      maxHeartRate: w.maxHeartRate,
    }).onConflictDoUpdate({
      target: [cardioActivity.providerId, cardioActivity.externalId],
      set: {
        activityType: w.activityType,
        endedAt: w.endDate,
        durationSeconds: Math.round(w.durationSeconds),
        distanceMeters: w.distanceMeters,
        calories: w.calories,
        avgHeartRate: w.avgHeartRate,
        maxHeartRate: w.maxHeartRate,
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

// ============================================================
// ZIP extraction
// ============================================================

/**
 * Extract export.xml from an Apple Health export ZIP file.
 * Returns the path to the extracted XML file in a temp directory.
 */
export function extractExportXml(zipPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const outDir = join(tmpdir(), `apple-health-import-${Date.now()}`);
    mkdirSync(outDir, { recursive: true });

    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err ?? new Error("Failed to open ZIP"));

      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        // Look for export.xml (may be in apple_health_export/ subdirectory)
        if (entry.fileName.endsWith("export.xml")) {
          zipfile.openReadStream(entry, (err2, readStream) => {
            if (err2 || !readStream) return reject(err2 ?? new Error("Failed to read entry"));
            const outPath = join(outDir, "export.xml");
            const writeStream = createWriteStream(outPath);
            readStream.pipe(writeStream);
            writeStream.on("finish", () => resolve(outPath));
            writeStream.on("error", reject);
          });
        } else {
          zipfile.readEntry();
        }
      });

      zipfile.on("end", () => {
        reject(new Error("No export.xml found in ZIP file"));
      });
      zipfile.on("error", reject);
    });
  });
}

// ============================================================
// Import logic (shared between CLI and sync)
// ============================================================

async function runImport(
  db: Database,
  providerId: string,
  xmlPath: string,
  since: Date,
): Promise<SyncResult> {
  const start = Date.now();
  const errors: SyncError[] = [];
  let recordsSynced = 0;

  try {
    const counts = await streamHealthExport(xmlPath, since, {
      onRecordBatch: async (records) => {
        const metricRecords = records.filter((r) => METRIC_STREAM_TYPES[r.type]);
        const bodyRecords = records.filter((r) => BODY_MEASUREMENT_TYPES.has(r.type));
        const dailyRecords = records.filter((r) => DAILY_METRIC_TYPES.has(r.type));

        if (metricRecords.length > 0) {
          const c = await upsertMetricStreamBatch(db, providerId, metricRecords);
          recordsSynced += c;
        }
        if (bodyRecords.length > 0) {
          const c = await upsertBodyMeasurementBatch(db, providerId, bodyRecords);
          recordsSynced += c;
        }
        if (dailyRecords.length > 0) {
          const c = await upsertDailyMetricsBatch(db, providerId, dailyRecords);
          recordsSynced += c;
        }
      },
      onSleepBatch: async (records) => {
        const c = await upsertSleepBatch(db, providerId, records);
        recordsSynced += c;
      },
      onWorkoutBatch: async (workouts) => {
        const c = await upsertWorkoutBatch(db, providerId, workouts);
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

  return { provider: providerId, recordsSynced, errors, duration: Date.now() - start };
}

/**
 * Import from a file path — accepts either a .zip or .xml file.
 */
export async function importAppleHealthFile(
  db: Database,
  filePath: string,
  since: Date,
): Promise<SyncResult> {
  await ensureProvider(db, "apple_health", "Apple Health");

  let xmlPath: string;
  let cleanupPath: string | null = null;

  if (filePath.endsWith(".zip")) {
    console.log(`[apple_health] Extracting ${filePath}...`);
    xmlPath = await extractExportXml(filePath);
    cleanupPath = xmlPath;
    console.log(`[apple_health] Extracted to ${xmlPath}`);
  } else {
    xmlPath = filePath;
  }

  console.log(`[apple_health] Importing from ${xmlPath} (since ${since.toISOString()})`);
  const result = await runImport(db, "apple_health", xmlPath, since);

  // Import clinical records (lab results) from zip
  if (filePath.endsWith(".zip")) {
    console.log("[apple_health] Importing clinical records...");
    const labCounts = await importClinicalRecords(db, "apple_health", filePath, xmlPath);
    result.recordsSynced += labCounts.inserted;
    if (labCounts.errors.length > 0) {
      result.errors.push(...labCounts.errors);
    }
    console.log(
      `[apple_health] ${labCounts.inserted} lab results, ` +
      `${labCounts.skipped} skipped, ${labCounts.errors.length} errors`,
    );
  }

  // Clean up extracted temp file
  if (cleanupPath) {
    try {
      const { rmSync: rm } = await import("fs");
      const { dirname: dir } = await import("path");
      rm(dir(cleanupPath), { recursive: true, force: true });
    } catch { /* best effort */ }
  }

  return result;
}

// ============================================================
// Clinical records import from ZIP
// ============================================================

function readZipEntries(
  zipPath: string,
  match: (name: string) => boolean,
): Promise<{ name: string; data: Buffer }[]> {
  return new Promise((resolve, reject) => {
    const results: { name: string; data: Buffer }[] = [];
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err ?? new Error("Failed to open ZIP"));

      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        if (match(entry.fileName)) {
          zipfile.openReadStream(entry, (err2, stream) => {
            if (err2 || !stream) { zipfile.readEntry(); return; }
            const chunks: Buffer[] = [];
            stream.on("data", (chunk: Buffer) => chunks.push(chunk));
            stream.on("end", () => {
              results.push({ name: entry.fileName, data: Buffer.concat(chunks) });
              zipfile.readEntry();
            });
            stream.on("error", () => zipfile.readEntry());
          });
        } else {
          zipfile.readEntry();
        }
      });

      zipfile.on("end", () => resolve(results));
      zipfile.on("error", reject);
    });
  });
}

/**
 * Stream the on-disk export.xml with SAX, extracting only <ClinicalRecord>
 * sourceName → resourceFilePath mappings. This avoids loading the full
 * 2.5GB XML into memory.
 */
function buildSourceNameMap(xmlPath: string): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const map = new Map<string, string>();
    const parser = sax.createStream(true, { trim: true });

    parser.on("opentag", (node) => {
      if (node.name === "ClinicalRecord") {
        const sourceName = node.attributes["sourceName"] as string | undefined;
        const resourcePath = node.attributes["resourceFilePath"] as string | undefined;
        if (sourceName && resourcePath) {
          map.set(resourcePath.replace(/^\//, ""), sourceName);
        }
      }
    });

    parser.on("end", () => resolve(map));
    parser.on("error", (err) => reject(err));

    createReadStream(xmlPath, { encoding: "utf8" }).pipe(parser);
  });
}

async function importClinicalRecords(
  db: Database,
  providerId: string,
  zipPath: string,
  xmlPath: string,
): Promise<{ inserted: number; skipped: number; errors: SyncError[] }> {
  const errors: SyncError[] = [];

  // Read all FHIR JSON files from the zip
  const clinicalFiles = await readZipEntries(zipPath, (name) =>
    name.includes("clinical-records/") && name.endsWith(".json"),
  );

  if (clinicalFiles.length === 0) {
    return { inserted: 0, skipped: 0, errors };
  }

  // Parse files, separating Observations from DiagnosticReports
  const observations: { obs: FhirObservation; fileName: string }[] = [];
  const diagnosticReports: FhirDiagnosticReport[] = [];
  let skipped = 0;

  for (const file of clinicalFiles) {
    try {
      const resource = JSON.parse(file.data.toString("utf-8"));
      if (resource.resourceType === "Observation") {
        observations.push({ obs: resource, fileName: file.name });
      } else if (resource.resourceType === "DiagnosticReport") {
        diagnosticReports.push(resource);
      } else {
        skipped++;
      }
    } catch (err) {
      errors.push({
        message: `Failed to parse ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Build panel map from DiagnosticReports
  const panelMap = buildPanelMap(diagnosticReports);

  // Build source name map from XML stubs
  const sourceNameMap = await buildSourceNameMap(xmlPath);

  // Parse and insert Observations
  let inserted = 0;
  const batch: (typeof labResult.$inferInsert)[] = [];

  for (const { obs, fileName } of observations) {
    // Only import lab results (skip vitals, etc.)
    const categories = Array.isArray(obs.category) ? obs.category : obs.category ? [obs.category] : [];
    const isLab = categories.some((cat) =>
      cat.coding?.some((c) => c.code === "laboratory" || c.code === "LAB"),
    );
    if (!isLab) { skipped++; continue; }

    try {
      const normalizedPath = fileName.replace(/^apple_health_export\//, "");
      const sourceName = sourceNameMap.get(normalizedPath) ?? "Unknown";
      const parsed = parseFhirObservation(obs, sourceName);
      const panelName = panelMap.get(obs.id);

      batch.push({
        providerId,
        externalId: parsed.externalId,
        testName: parsed.testName,
        loincCode: parsed.loincCode,
        value: parsed.value,
        valueText: parsed.valueText,
        unit: parsed.unit,
        referenceRangeLow: parsed.referenceRangeLow,
        referenceRangeHigh: parsed.referenceRangeHigh,
        referenceRangeText: parsed.referenceRangeText,
        panelName,
        status: parsed.status,
        sourceName: parsed.sourceName,
        recordedAt: parsed.recordedAt,
        issuedAt: parsed.issuedAt,
        raw: parsed.raw,
      });

      if (batch.length >= 500) {
        await db.insert(labResult).values(batch).onConflictDoNothing();
        inserted += batch.length;
        batch.length = 0;
      }
    } catch (err) {
      errors.push({
        message: `Observation ${obs.id}: ${err instanceof Error ? err.message : String(err)}`,
        externalId: obs.id,
      });
    }
  }

  if (batch.length > 0) {
    await db.insert(labResult).values(batch).onConflictDoNothing();
    inserted += batch.length;
  }

  return { inserted, skipped, errors };
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
      // Look for both .xml and .zip files
      const files = readdirSync(dir)
        .filter((f) => f.endsWith(".xml") || f.endsWith(".zip"))
        .map((f) => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);

      return files.length > 0 ? join(dir, files[0].name) : null;
    } catch {
      return null;
    }
  }

  async sync(db: Database, since: Date): Promise<SyncResult> {
    const filePath = this.findLatestExport();
    if (!filePath) {
      return {
        provider: this.id,
        recordsSynced: 0,
        errors: [{ message: "No Apple Health export found in APPLE_HEALTH_IMPORT_DIR" }],
        duration: 0,
      };
    }

    return importAppleHealthFile(db, filePath, since);
  }
}

// ============================================================
// FHIR Clinical Records — Lab Results
// ============================================================

export interface FhirCoding {
  system?: string;
  code?: string;
  display?: string;
}

export interface FhirCodeableConcept {
  text?: string;
  coding?: FhirCoding[];
}

export interface FhirQuantity {
  value?: number;
  unit?: string;
  system?: string;
  code?: string;
}

export interface FhirReferenceRange {
  low?: FhirQuantity;
  high?: FhirQuantity;
  text?: string;
}

export interface FhirObservation {
  resourceType: "Observation";
  id: string;
  status?: string;
  category?: FhirCodeableConcept | FhirCodeableConcept[];
  code: FhirCodeableConcept;
  valueQuantity?: FhirQuantity;
  valueString?: string;
  referenceRange?: FhirReferenceRange[];
  effectiveDateTime?: string;
  issued?: string;
}

export interface FhirDiagnosticReport {
  resourceType: "DiagnosticReport";
  id: string;
  status?: string;
  code: FhirCodeableConcept;
  effectiveDateTime?: string;
  issued?: string;
  result?: { reference: string }[];
}

const VALID_LAB_STATUSES = new Set(["final", "preliminary", "corrected", "cancelled"]);
type LabResultStatus = "final" | "preliminary" | "corrected" | "cancelled";

export interface ParsedLabResult {
  externalId: string;
  testName: string;
  loincCode?: string;
  value?: number;
  valueText?: string;
  unit?: string;
  referenceRangeLow?: number;
  referenceRangeHigh?: number;
  referenceRangeText?: string;
  status?: LabResultStatus;
  sourceName: string;
  recordedAt: Date;
  issuedAt?: Date;
  raw: Record<string, unknown>;
}

/**
 * Extract the LOINC code from a FHIR CodeableConcept's coding array.
 */
function extractLoincCode(concept: FhirCodeableConcept): string | undefined {
  return concept.coding?.find((c) => c.system === "http://loinc.org")?.code;
}

/**
 * Get display name from a CodeableConcept — prefer text, then coding display.
 */
function getDisplayName(concept: FhirCodeableConcept): string {
  if (concept.text) return concept.text;
  for (const coding of concept.coding ?? []) {
    if (coding.display) return coding.display;
  }
  return concept.coding?.[0]?.code ?? "Unknown";
}

/**
 * Parse a FHIR Observation into a ParsedLabResult.
 */
export function parseFhirObservation(obs: FhirObservation, sourceName: string): ParsedLabResult {
  const result: ParsedLabResult = {
    externalId: obs.id,
    testName: getDisplayName(obs.code),
    loincCode: extractLoincCode(obs.code),
    status: obs.status && VALID_LAB_STATUSES.has(obs.status) ? (obs.status as LabResultStatus) : undefined,
    sourceName,
    recordedAt: new Date(obs.effectiveDateTime ?? obs.issued ?? ""),
    issuedAt: obs.issued ? new Date(obs.issued) : undefined,
    raw: obs as unknown as Record<string, unknown>,
  };

  // Value: numeric or text
  if (obs.valueQuantity?.value != null) {
    result.value = obs.valueQuantity.value;
    result.unit = obs.valueQuantity.unit;
  } else if (obs.valueString) {
    result.valueText = obs.valueString;
  }

  // Reference range
  const range = obs.referenceRange?.[0];
  if (range) {
    if (range.low?.value != null) result.referenceRangeLow = range.low.value;
    if (range.high?.value != null) result.referenceRangeHigh = range.high.value;
    if (range.text && !range.low && !range.high) result.referenceRangeText = range.text;
  }

  return result;
}

/**
 * Build a map from Observation FHIR ID → panel name, using DiagnosticReports.
 */
export function buildPanelMap(reports: FhirDiagnosticReport[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const report of reports) {
    const panelName = getDisplayName(report.code);
    for (const ref of report.result ?? []) {
      // reference format: "Observation/obs-id-here"
      const obsId = ref.reference.replace(/^Observation\//, "");
      map.set(obsId, panelName);
    }
  }
  return map;
}
