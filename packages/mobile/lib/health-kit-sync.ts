import type {
  DailyStatistic,
  HealthKitSample,
  RouteLocation,
  SleepSample,
  WorkoutSample,
} from "../modules/health-kit";

// Additive types use HKStatisticsCollectionQuery for proper source deduplication.
// Without this, overlapping samples from iPhone + Apple Watch get summed, roughly
// doubling the real values (e.g., 3k steps shown when the user walked 1.5k).
export const ADDITIVE_QUANTITY_TYPES = [
  "HKQuantityTypeIdentifierStepCount",
  "HKQuantityTypeIdentifierActiveEnergyBurned",
  "HKQuantityTypeIdentifierBasalEnergyBurned",
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
];

const ALL_QUANTITY_TYPES = [...ADDITIVE_QUANTITY_TYPES, ...NON_ADDITIVE_QUANTITY_TYPES];

const BATCH_SIZE = 500;

function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

function normalizeWorkout(workout: WorkoutSample): WorkoutSample {
  return {
    ...workout,
    totalEnergyBurned: workout.totalEnergyBurned ?? null,
    totalDistance: workout.totalDistance ?? null,
  };
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
      mutate(input: { workouts: WorkoutSample[] }): Promise<{ inserted: number }>;
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
  /** Number of days to sync, or null for all-time */
  syncRangeDays: number | null;
  onProgress?: (message: string) => void;
}

export interface SyncResult {
  inserted: number;
  errors: string[];
}

/**
 * Core HealthKit sync logic extracted from the health screen component.
 * Queries all HealthKit types and pushes them to the server via tRPC.
 */
export async function syncHealthKitToServer(options: SyncOptions): Promise<SyncResult> {
  const { trpcClient, healthKit, syncRangeDays, onProgress } = options;

  const startDate = syncRangeDays === null ? new Date(0).toISOString() : daysAgo(syncRangeDays);
  const endDate = new Date().toISOString();

  const allSamples: HealthKitSample[] = [];
  const totalTypes = ALL_QUANTITY_TYPES.length;
  let typeIndex = 0;

  // Additive types: use statistics query for proper deduplication
  for (const typeId of ADDITIVE_QUANTITY_TYPES) {
    const shortName = typeId.replace("HKQuantityTypeIdentifier", "");
    onProgress?.(`Querying ${shortName}... (${typeIndex + 1}/${totalTypes})`);

    const dailyStats = await healthKit.queryDailyStatistics(typeId, startDate, endDate);
    for (const stat of dailyStats) {
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

    const samples = await healthKit.queryQuantitySamples(typeId, startDate, endDate);
    allSamples.push(...samples);
    typeIndex++;
  }

  let totalInserted = 0;
  const errors: string[] = [];

  // Push quantity samples in batches
  if (allSamples.length > 0) {
    onProgress?.(`Pushing ${allSamples.length} samples...`);
    for (let i = 0; i < allSamples.length; i += BATCH_SIZE) {
      const batch = allSamples.slice(i, i + BATCH_SIZE);
      const result = await trpcClient.healthKitSync.pushQuantitySamples.mutate({ samples: batch });
      totalInserted += result.inserted;
      errors.push(...result.errors);
    }
  }

  // Sync workouts
  onProgress?.("Querying workouts...");
  const workouts = (await healthKit.queryWorkouts(startDate, endDate)).map(normalizeWorkout);
  if (workouts.length > 0) {
    const result = await trpcClient.healthKitSync.pushWorkouts.mutate({ workouts });
    totalInserted += result.inserted;

    // Fetch GPS routes for each workout (parallel with bounded concurrency, non-fatal errors)
    onProgress?.("Querying workout routes...");
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
          try {
            const locations = await healthKit.queryWorkoutRoutes(workout.uuid);
            if (locations.length > 0) {
              workerRoutes.push({
                workoutUuid: workout.uuid,
                sourceName: workout.sourceName,
                locations,
              });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`Route query for workout ${workout.uuid}: ${message}`);
          }
        }
        return workerRoutes;
      }),
    );
    const routes = routeGroups.flat();

    if (routes.length > 0) {
      onProgress?.(`Pushing ${routes.length} workout routes...`);
      try {
        const routeResult = await trpcClient.healthKitSync.pushWorkoutRoutes.mutate({ routes });
        totalInserted += routeResult.inserted;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Push workout routes: ${message}`);
      }
    }
  }

  // Sync sleep
  onProgress?.("Querying sleep...");
  const sleepSamples = await healthKit.querySleepSamples(startDate, endDate);
  if (sleepSamples.length > 0) {
    const result = await trpcClient.healthKitSync.pushSleepSamples.mutate({
      samples: sleepSamples,
    });
    totalInserted += result.inserted;
  }

  return { inserted: totalInserted, errors };
}
