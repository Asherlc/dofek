import type {
  DailyStatistic,
  HealthKitSample,
  RouteLocation,
  SleepSample,
  WorkoutSample,
} from "../modules/health-kit";
import { isAfterDeviceErasureCutoff } from "./device-erasure-cutoff";
import { isHealthKitDatabaseInaccessible } from "./health-kit-errors";
import { captureException } from "./telemetry";

// Additive types use HKStatisticsCollectionQuery for proper source deduplication.
// Without this, overlapping samples from iPhone + Apple Watch get summed, roughly
// doubling the real values (e.g., 3k steps shown when the user walked 1.5k).
export const ADDITIVE_QUANTITY_TYPES = [
  "HKQuantityTypeIdentifierStepCount",
  "HKQuantityTypeIdentifierDistanceWalkingRunning",
  "HKQuantityTypeIdentifierFlightsClimbed",
  "HKQuantityTypeIdentifierAppleExerciseTime",
];

// Non-additive types use raw HKSampleQuery (no deduplication needed since
// these are point-in-time or discrete measurements, not cumulative sums).
export const NON_ADDITIVE_QUANTITY_TYPES = [
  "HKQuantityTypeIdentifierBodyMass",
  "HKQuantityTypeIdentifierBodyFatPercentage",
  "HKQuantityTypeIdentifierHeartRate",
  "HKQuantityTypeIdentifierRestingHeartRate",
  "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
  "HKQuantityTypeIdentifierVO2Max",
  "HKQuantityTypeIdentifierOxygenSaturation",
  "HKQuantityTypeIdentifierRespiratoryRate",
  "HKQuantityTypeIdentifierAppleSleepingWristTemperature",
  "HKQuantityTypeIdentifierWalkingSpeed",
  "HKQuantityTypeIdentifierWalkingStepLength",
  "HKQuantityTypeIdentifierWalkingDoubleSupportPercentage",
  "HKQuantityTypeIdentifierWalkingAsymmetryPercentage",
  "HKQuantityTypeIdentifierAppleWalkingSteadiness",
];

const ALL_QUANTITY_TYPES = [...ADDITIVE_QUANTITY_TYPES, ...NON_ADDITIVE_QUANTITY_TYPES];

const BATCH_SIZE = 500;

function syncWindowStart(syncRangeDays: number | null, minimumSampleDate: string | null): string {
  let rangeStart: string;
  if (syncRangeDays === null) {
    rangeStart = new Date(0).toISOString();
  } else {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - syncRangeDays);
    startDate.setHours(0, 0, 0, 0);
    rangeStart = startDate.toISOString();
  }

  if (minimumSampleDate === null) return rangeStart;
  const cutoffTime = Date.parse(minimumSampleDate);
  if (!Number.isFinite(cutoffTime)) {
    throw new Error("Device erasure cutoff is invalid.");
  }
  return cutoffTime > Date.parse(rangeStart) ? minimumSampleDate : rangeStart;
}

function localCalendarDate(timestamp: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Device erasure cutoff is invalid.");
  }
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function normalizeWorkout(workout: WorkoutSample): WorkoutSample {
  return {
    ...workout,
    totalDistance: workout.totalDistance ?? null,
  };
}

function isAuthorizationNotDetermined(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "HEALTHKIT_AUTHORIZATION_NOT_DETERMINED";
}

/** Abstraction over HealthKit native module for testability */
export interface HealthKitAdapter {
  queryDailyStatistics(
    typeId: string,
    startDate: string,
    endDate: string,
  ): Promise<DailyStatistic[]>;
  queryQuantitySamples(
    typeId: string,
    startDate: string,
    endDate: string,
  ): Promise<HealthKitSample[]>;
  queryWorkouts(startDate: string, endDate: string): Promise<WorkoutSample[]>;
  querySleepSamples(startDate: string, endDate: string): Promise<SleepSample[]>;
  queryWorkoutRoutes(workoutUuid: string): Promise<RouteLocation[]>;
}

/** Route data to push for a single workout */
interface WorkoutRoutePayload {
  workoutUuid: string;
  sourceName?: string | null;
  locations: RouteLocation[];
}

/** Abstraction over tRPC client for testability */
export interface SyncTrpcClient {
  healthKitSync: {
    pushQuantitySamples: {
      mutate(input: {
        samples: HealthKitSample[];
      }): Promise<{ inserted: number; errors: string[] }>;
    };
    pushWorkouts: {
      mutate(input: {
        workouts: WorkoutSample[];
        windowStart: string;
        windowEnd: string;
      }): Promise<{ inserted: number }>;
    };
    pushWorkoutRoutes: {
      mutate(input: { routes: WorkoutRoutePayload[] }): Promise<{ inserted: number }>;
    };
    pushSleepSamples: {
      mutate(input: { samples: SleepSample[] }): Promise<{ inserted: number }>;
    };
  };
}

export interface SyncOptions {
  trpcClient: SyncTrpcClient;
  healthKit: HealthKitAdapter;
  /** Device-wide lower bound retained across deleted accounts. */
  minimumSampleDate?: string | null;
  /** Number of days to sync, or null for all-time */
  syncRangeDays: number | null;
  onProgress?: (message: string) => void;
  onStage?: (stage: HealthKitSyncStage) => void;
}

export interface SyncResult {
  inserted: number;
  errors: string[];
}

export interface HealthKitSyncStage {
  operation:
    | "queryDailyStatistics"
    | "queryQuantitySamples"
    | "pushQuantitySamples"
    | "queryWorkouts"
    | "pushWorkouts"
    | "queryWorkoutRoutes"
    | "pushWorkoutRoutes"
    | "querySleepSamples"
    | "pushSleepSamples";
  typeIdentifier?: string;
  batchIndex?: number;
  batchCount?: number;
  itemCount?: number;
}

/**
 * Core HealthKit sync logic extracted from the health screen component.
 * Queries all HealthKit types and pushes them to the server via tRPC.
 */
export async function syncHealthKitToServer(options: SyncOptions): Promise<SyncResult> {
  const {
    trpcClient,
    healthKit,
    minimumSampleDate = null,
    syncRangeDays,
    onProgress,
    onStage,
  } = options;

  const startDate = syncWindowStart(syncRangeDays, minimumSampleDate);
  const endDate = new Date().toISOString();
  const cutoffCalendarDate =
    minimumSampleDate === null ? null : localCalendarDate(minimumSampleDate);

  const allSamples: HealthKitSample[] = [];
  const totalTypes = ALL_QUANTITY_TYPES.length;
  let typeIndex = 0;

  // Additive types: use statistics query for proper deduplication
  for (const typeId of ADDITIVE_QUANTITY_TYPES) {
    const shortName = typeId.replace("HKQuantityTypeIdentifier", "");
    onProgress?.(`Querying ${shortName}... (${typeIndex + 1}/${totalTypes})`);
    onStage?.({
      operation: "queryDailyStatistics",
      typeIdentifier: typeId,
    });

    let dailyStats: DailyStatistic[];
    try {
      dailyStats = await healthKit.queryDailyStatistics(typeId, startDate, endDate);
    } catch (error) {
      if (!isAuthorizationNotDetermined(error)) {
        throw error;
      }
      dailyStats = [];
    }
    for (const stat of dailyStats) {
      if (cutoffCalendarDate !== null && stat.date <= cutoffCalendarDate) {
        continue;
      }
      allSamples.push({
        type: typeId,
        value: stat.value,
        unit: "statistics",
        startDate: `${stat.date}T12:00:00Z`,
        endDate: `${stat.date}T12:00:00Z`,
        sourceName: "HealthKit",
        sourceBundle: "com.apple.Health",
        uuid: `stat:${typeId}:${stat.date}`,
      });
    }
    typeIndex++;
  }

  // Non-additive types: raw sample query
  for (const typeId of NON_ADDITIVE_QUANTITY_TYPES) {
    const shortName = typeId.replace("HKQuantityTypeIdentifier", "");
    onProgress?.(`Querying ${shortName}... (${typeIndex + 1}/${totalTypes})`);
    onStage?.({
      operation: "queryQuantitySamples",
      typeIdentifier: typeId,
    });

    const samples = await healthKit.queryQuantitySamples(typeId, startDate, endDate);
    allSamples.push(
      ...samples.filter(
        (sample) =>
          minimumSampleDate === null ||
          isAfterDeviceErasureCutoff(sample.startDate, minimumSampleDate),
      ),
    );
    typeIndex++;
  }

  let totalInserted = 0;
  const errors: string[] = [];

  // Push quantity samples in batches
  if (allSamples.length > 0) {
    onProgress?.(`Pushing ${allSamples.length} samples...`);
    const batchCount = Math.ceil(allSamples.length / BATCH_SIZE);
    for (let batchOffset = 0; batchOffset < allSamples.length; batchOffset += BATCH_SIZE) {
      const batch = allSamples.slice(batchOffset, batchOffset + BATCH_SIZE);
      onStage?.({
        operation: "pushQuantitySamples",
        batchIndex: batchOffset / BATCH_SIZE + 1,
        batchCount,
        itemCount: batch.length,
      });
      const result = await trpcClient.healthKitSync.pushQuantitySamples.mutate({ samples: batch });
      totalInserted += result.inserted;
      errors.push(...result.errors);
    }
  }

  // Sync workouts
  onProgress?.("Querying workouts...");
  onStage?.({ operation: "queryWorkouts" });
  const workouts = (await healthKit.queryWorkouts(startDate, endDate))
    .filter(
      (workout) =>
        minimumSampleDate === null ||
        isAfterDeviceErasureCutoff(workout.startDate, minimumSampleDate),
    )
    .map(normalizeWorkout);
  {
    onStage?.({
      operation: "pushWorkouts",
      itemCount: workouts.length,
    });
    const result = await trpcClient.healthKitSync.pushWorkouts.mutate({
      workouts,
      windowStart: startDate,
      windowEnd: endDate,
    });
    totalInserted += result.inserted;

    // Fetch GPS routes for each workout (parallel with bounded concurrency, non-fatal errors)
    onProgress?.("Querying workout routes...");
    onStage?.({
      operation: "queryWorkoutRoutes",
      itemCount: workouts.length,
    });
    const routeQueryConcurrency = Math.min(4, workouts.length);
    const routeGroups = await Promise.all(
      Array.from({ length: routeQueryConcurrency }, async (_, workerIndex) => {
        const workerRoutes: WorkoutRoutePayload[] = [];
        for (
          let workoutIndex = workerIndex;
          workoutIndex < workouts.length;
          workoutIndex += routeQueryConcurrency
        ) {
          const workout = workouts[workoutIndex];
          if (!workout) {
            continue;
          }
          try {
            const locations = (await healthKit.queryWorkoutRoutes(workout.uuid)).filter(
              (location) =>
                minimumSampleDate === null ||
                isAfterDeviceErasureCutoff(location.date, minimumSampleDate),
            );
            if (locations.length > 0) {
              workerRoutes.push({
                workoutUuid: workout.uuid,
                sourceName: workout.sourceName,
                locations,
              });
            }
          } catch (error) {
            if (isHealthKitDatabaseInaccessible(error)) {
              throw error;
            }
            captureException(error, {
              source: "health-kit-workout-route-query",
              workoutUuid: workout.uuid,
            });
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`Route query for workout ${workout.uuid}: ${message}`);
          }
        }
        return workerRoutes;
      }),
    );
    const routes = routeGroups.flat();

    if (workouts.length > 0 && routes.length > 0) {
      onProgress?.(`Pushing ${routes.length} workout routes...`);
      onStage?.({
        operation: "pushWorkoutRoutes",
        itemCount: routes.length,
      });
      try {
        const routeResult = await trpcClient.healthKitSync.pushWorkoutRoutes.mutate({ routes });
        totalInserted += routeResult.inserted;
      } catch (error) {
        captureException(error, {
          source: "health-kit-workout-route-push",
          routeCount: routes.length,
        });
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Push workout routes: ${message}`);
      }
    }
  }

  // Sync sleep
  onProgress?.("Querying sleep...");
  onStage?.({ operation: "querySleepSamples" });
  const sleepSamples = (await healthKit.querySleepSamples(startDate, endDate)).filter(
    (sample) =>
      minimumSampleDate === null || isAfterDeviceErasureCutoff(sample.startDate, minimumSampleDate),
  );
  if (sleepSamples.length > 0) {
    onStage?.({
      operation: "pushSleepSamples",
      itemCount: sleepSamples.length,
    });
    const result = await trpcClient.healthKitSync.pushSleepSamples.mutate({
      samples: sleepSamples,
    });
    totalInserted += result.inserted;
  }

  return { inserted: totalInserted, errors };
}
