import type {
  DailyStatistic,
  HealthKitSample,
  RouteLocation,
  SleepSample,
  WorkoutSample,
} from "./platform-native/health";
import { isAfterDeviceErasureCutoff } from "./device-erasure-cutoff";
import {
  isBackgroundHealthKitTransientNetworkError,
  isHealthKitDatabaseInaccessible,
} from "./health-kit-errors";
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

export const SLEEP_TYPE_IDENTIFIER = "HKCategoryTypeIdentifierSleepAnalysis";
export const WORKOUT_TYPE_IDENTIFIER = "HKWorkoutTypeIdentifier";
export const WORKOUT_ROUTE_TYPE_IDENTIFIER = "HKWorkoutRouteTypeIdentifier";

const ANCHORED_QUANTITY_TYPES = new Set([
  "HKQuantityTypeIdentifierBodyMass",
  "HKQuantityTypeIdentifierBodyFatPercentage",
  "HKQuantityTypeIdentifierHeartRate",
  "HKQuantityTypeIdentifierRestingHeartRate",
  "HKQuantityTypeIdentifierVO2Max",
  "HKQuantityTypeIdentifierRespiratoryRate",
]);

const ALL_QUANTITY_TYPES = [...ADDITIVE_QUANTITY_TYPES, ...NON_ADDITIVE_QUANTITY_TYPES];

export const BACKGROUND_HEALTH_KIT_TYPES = [
  ...ALL_QUANTITY_TYPES,
  SLEEP_TYPE_IDENTIFIER,
  WORKOUT_TYPE_IDENTIFIER,
  WORKOUT_ROUTE_TYPE_IDENTIFIER,
];

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

interface WorkoutRouteErrorContext {
  errors: string[];
  errorLabel: string;
  source: string;
  captureContext?: Record<string, unknown>;
  suppressTransientNetworkErrors?: boolean;
}

function handleWorkoutRouteError(
  error: unknown,
  context: WorkoutRouteErrorContext,
): "locked" | undefined {
  if (isHealthKitDatabaseInaccessible(error)) {
    return "locked";
  }
  const shouldReport =
    !context.suppressTransientNetworkErrors || !isBackgroundHealthKitTransientNetworkError(error);
  if (shouldReport) {
    captureException(error, {
      source: context.source,
      ...context.captureContext,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  context.errors.push(`${context.errorLabel}: ${message}`);
}

function isAuthorizationNotDetermined(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "HEALTHKIT_AUTHORIZATION_NOT_DETERMINED";
}

/** Abstraction over HealthKit native module for testability */
export interface HealthKitAdapter {
  completeAnchoredQuery(typeId: string, queryId: string, succeeded: boolean): Promise<boolean>;
  queryAnchoredSamples(
    typeId: string,
    initialStartDate: string,
  ): Promise<{
    queryId: string | null;
    samples: HealthKitSample[];
    deletedUUIDs: string[];
  }>;
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
    deleteQuantitySamples: {
      mutate(input: {
        deletedUUIDs: string[];
        typeIdentifier: string;
      }): Promise<{ deleted: number }>;
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
  deleted: number;
  inserted: number;
  errors: string[];
}

export interface HealthKitSyncStage {
  operation:
    | "completeAnchoredQuery"
    | "deleteQuantitySamples"
    | "queryAnchoredSamples"
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

async function pushQuantitySampleBatches(
  trpcClient: SyncTrpcClient,
  samples: HealthKitSample[],
  onStage?: (stage: HealthKitSyncStage) => void,
): Promise<SyncResult> {
  let inserted = 0;
  const errors: string[] = [];
  const batchCount = Math.ceil(samples.length / BATCH_SIZE);
  for (let batchOffset = 0; batchOffset < samples.length; batchOffset += BATCH_SIZE) {
    const batch = samples.slice(batchOffset, batchOffset + BATCH_SIZE);
    onStage?.({
      operation: "pushQuantitySamples",
      batchIndex: batchOffset / BATCH_SIZE + 1,
      batchCount,
      itemCount: batch.length,
    });
    const result = await trpcClient.healthKitSync.pushQuantitySamples.mutate({ samples: batch });
    inserted += result.inserted;
    errors.push(...result.errors);
  }
  return { deleted: 0, inserted, errors };
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
    const result = await pushQuantitySampleBatches(trpcClient, allSamples, onStage);
    totalInserted += result.inserted;
    errors.push(...result.errors);
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
            handleWorkoutRouteError(error, {
              errors,
              errorLabel: `Route query for workout ${workout.uuid}`,
              source: "health-kit-workout-route-query",
              captureContext: { workoutUuid: workout.uuid },
            });
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
        handleWorkoutRouteError(error, {
          errors,
          errorLabel: "Push workout routes",
          source: "health-kit-workout-route-push",
          captureContext: { routeCount: routes.length },
          suppressTransientNetworkErrors: true,
        });
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

  return { deleted: 0, inserted: totalInserted, errors };
}

export interface ObserverSyncOptions {
  trpcClient: SyncTrpcClient;
  healthKit: HealthKitAdapter;
  /** Device-wide lower bound retained across deleted accounts. */
  minimumSampleDate?: string | null;
  typeIdentifiers: readonly string[];
  onStage?: (stage: HealthKitSyncStage) => void;
}

function dailyStatisticsSamples(
  typeIdentifier: string,
  statistics: DailyStatistic[],
): HealthKitSample[] {
  return statistics.map((statistic) => ({
    type: typeIdentifier,
    value: statistic.value,
    unit: "statistics",
    startDate: `${statistic.date}T12:00:00Z`,
    endDate: `${statistic.date}T12:00:00Z`,
    sourceName: "HealthKit",
    sourceBundle: "com.apple.Health",
    uuid: `stat:${typeIdentifier}:${statistic.date}`,
  }));
}

async function syncAnchoredQuantityType(
  options: ObserverSyncOptions,
  typeIdentifier: string,
  initialStartDate: string,
): Promise<SyncResult> {
  const { healthKit, minimumSampleDate = null, onStage, trpcClient } = options;
  onStage?.({ operation: "queryAnchoredSamples", typeIdentifier });
  const changes = await healthKit.queryAnchoredSamples(typeIdentifier, initialStartDate);

  try {
    const uploadResult = await pushQuantitySampleBatches(
      trpcClient,
      changes.samples.filter(
        (sample) =>
          minimumSampleDate === null ||
          isAfterDeviceErasureCutoff(sample.startDate, minimumSampleDate),
      ),
      onStage,
    );
    if (uploadResult.errors.length > 0) {
      throw new Error(uploadResult.errors.join("; "));
    }

    let deleted = 0;
    if (changes.deletedUUIDs.length > 0) {
      const batchCount = Math.ceil(changes.deletedUUIDs.length / BATCH_SIZE);
      for (
        let batchOffset = 0;
        batchOffset < changes.deletedUUIDs.length;
        batchOffset += BATCH_SIZE
      ) {
        const deletedUUIDs = changes.deletedUUIDs.slice(batchOffset, batchOffset + BATCH_SIZE);
        onStage?.({
          operation: "deleteQuantitySamples",
          typeIdentifier,
          batchIndex: batchOffset / BATCH_SIZE + 1,
          batchCount,
          itemCount: deletedUUIDs.length,
        });
        const deleteResult = await trpcClient.healthKitSync.deleteQuantitySamples.mutate({
          deletedUUIDs,
          typeIdentifier,
        });
        deleted += deleteResult.deleted;
      }
    }

    if (changes.queryId) {
      onStage?.({ operation: "completeAnchoredQuery", typeIdentifier });
      const committed = await healthKit.completeAnchoredQuery(
        typeIdentifier,
        changes.queryId,
        true,
      );
      if (!committed) {
        throw new Error(
          `HealthKit anchor commit rejected for ${typeIdentifier} (query ${changes.queryId})`,
        );
      }
    }
    return {
      deleted,
      inserted: uploadResult.inserted,
      errors: [],
    };
  } catch (error) {
    if (changes.queryId) {
      try {
        onStage?.({ operation: "completeAnchoredQuery", typeIdentifier });
        await healthKit.completeAnchoredQuery(typeIdentifier, changes.queryId, false);
      } catch (completionError) {
        captureException(completionError, {
          source: "health-kit-anchor-completion",
          typeIdentifier,
        });
      }
    }
    throw error;
  }
}

async function syncObserverWorkouts(
  options: ObserverSyncOptions,
  startDate: string,
  endDate: string,
): Promise<SyncResult> {
  const { healthKit, minimumSampleDate = null, onStage, trpcClient } = options;
  const errors: string[] = [];
  onStage?.({ operation: "queryWorkouts" });
  const workouts = (await healthKit.queryWorkouts(startDate, endDate))
    .filter(
      (workout) =>
        minimumSampleDate === null ||
        isAfterDeviceErasureCutoff(workout.startDate, minimumSampleDate),
    )
    .map(normalizeWorkout);
  onStage?.({ operation: "pushWorkouts", itemCount: workouts.length });
  const workoutResult = await trpcClient.healthKitSync.pushWorkouts.mutate({
    workouts,
    windowStart: startDate,
    windowEnd: endDate,
  });
  let inserted = workoutResult.inserted;
  const routes: WorkoutRoutePayload[] = [];

  onStage?.({ operation: "queryWorkoutRoutes", itemCount: workouts.length });
  for (const workout of workouts) {
    try {
      const locations = (await healthKit.queryWorkoutRoutes(workout.uuid)).filter(
        (location) =>
          minimumSampleDate === null ||
          isAfterDeviceErasureCutoff(location.date, minimumSampleDate),
      );
      if (locations.length === 0) {
        continue;
      }
      routes.push({
        workoutUuid: workout.uuid,
        sourceName: workout.sourceName,
        locations,
      });
    } catch (error) {
      if (isHealthKitDatabaseInaccessible(error)) {
        throw error;
      }
      handleWorkoutRouteError(error, {
        errors,
        errorLabel: `Route sync for workout ${workout.uuid}`,
        source: "health-kit-workout-route-observer-sync",
        captureContext: { workoutUuid: workout.uuid },
      });
    }
  }

  if (routes.length > 0) {
    onStage?.({ operation: "pushWorkoutRoutes", itemCount: routes.length });
    try {
      const routeResult = await trpcClient.healthKitSync.pushWorkoutRoutes.mutate({ routes });
      inserted += routeResult.inserted;
    } catch (error) {
      handleWorkoutRouteError(error, {
        errors,
        errorLabel: "Push workout routes",
        source: "health-kit-workout-route-observer-push",
        captureContext: { routeCount: routes.length },
        suppressTransientNetworkErrors: true,
      });
    }
  }
  return { deleted: 0, inserted, errors };
}

/**
 * Processes only the sample types named by HealthKit observer deliveries.
 * Raw UUID-addressable types use two-phase anchors; derived daily values use
 * a bounded type-specific refresh so their aggregation semantics stay intact.
 */
export async function syncHealthKitObserverChanges(
  options: ObserverSyncOptions,
): Promise<SyncResult> {
  const { healthKit, minimumSampleDate = null, onStage, trpcClient } = options;
  const typeIdentifiers = new Set(options.typeIdentifiers);
  // A reset native anchor must replay every sample after the device cutoff so
  // the next account does not miss HealthKit history that belongs after the
  // previous account was erased. Once the anchor is persisted, native code
  // keeps subsequent observer queries incremental.
  const startDate =
    minimumSampleDate === null
      ? syncWindowStart(1, null)
      : syncWindowStart(null, minimumSampleDate);
  const endDate = new Date().toISOString();
  const cutoffCalendarDate =
    minimumSampleDate === null ? null : localCalendarDate(minimumSampleDate);
  let deleted = 0;
  let inserted = 0;
  const errors: string[] = [];

  for (const typeIdentifier of ADDITIVE_QUANTITY_TYPES) {
    if (!typeIdentifiers.has(typeIdentifier)) {
      continue;
    }
    onStage?.({ operation: "queryDailyStatistics", typeIdentifier });
    let statistics: DailyStatistic[];
    try {
      statistics = await healthKit.queryDailyStatistics(typeIdentifier, startDate, endDate);
    } catch (error) {
      if (!isAuthorizationNotDetermined(error)) {
        throw error;
      }
      statistics = [];
    }
    const result = await pushQuantitySampleBatches(
      trpcClient,
      dailyStatisticsSamples(
        typeIdentifier,
        statistics.filter(
          (statistic) => cutoffCalendarDate === null || statistic.date > cutoffCalendarDate,
        ),
      ),
      onStage,
    );
    inserted += result.inserted;
    errors.push(...result.errors);
  }

  for (const typeIdentifier of NON_ADDITIVE_QUANTITY_TYPES) {
    if (!typeIdentifiers.has(typeIdentifier)) {
      continue;
    }
    if (ANCHORED_QUANTITY_TYPES.has(typeIdentifier)) {
      const result = await syncAnchoredQuantityType(options, typeIdentifier, startDate);
      deleted += result.deleted;
      inserted += result.inserted;
      errors.push(...result.errors);
      continue;
    }

    onStage?.({ operation: "queryQuantitySamples", typeIdentifier });
    const samples = (
      await healthKit.queryQuantitySamples(typeIdentifier, startDate, endDate)
    ).filter(
      (sample) =>
        minimumSampleDate === null ||
        isAfterDeviceErasureCutoff(sample.startDate, minimumSampleDate),
    );
    const result = await pushQuantitySampleBatches(trpcClient, samples, onStage);
    inserted += result.inserted;
    errors.push(...result.errors);
  }

  if (
    typeIdentifiers.has(WORKOUT_TYPE_IDENTIFIER) ||
    typeIdentifiers.has(WORKOUT_ROUTE_TYPE_IDENTIFIER)
  ) {
    const result = await syncObserverWorkouts(options, startDate, endDate);
    inserted += result.inserted;
    errors.push(...result.errors);
  }

  if (typeIdentifiers.has(SLEEP_TYPE_IDENTIFIER)) {
    onStage?.({ operation: "querySleepSamples" });
    const samples = (await healthKit.querySleepSamples(startDate, endDate)).filter(
      (sample) =>
        minimumSampleDate === null ||
        isAfterDeviceErasureCutoff(sample.startDate, minimumSampleDate),
    );
    if (samples.length > 0) {
      onStage?.({ operation: "pushSleepSamples", itemCount: samples.length });
      const result = await trpcClient.healthKitSync.pushSleepSamples.mutate({ samples });
      inserted += result.inserted;
    }
  }

  return { deleted, inserted, errors };
}
