import type {
  ClinicalRecordSample,
  DailyStatistic,
  HealthKitSample,
  RouteLocation,
  RunningStepChanges,
  RunningStepSample,
  RunningStepSnapshot,
  SleepSample,
  WorkoutSample,
} from "../modules/health-kit";

/** Abstraction over HealthKit native module for testability */
export interface HealthKitAdapter {
  queryRunningStepSamples(startDate: string, endDate: string): Promise<RunningStepSnapshot>;
  queryRunningStepChanges(initialStartDate: string): Promise<RunningStepChanges>;
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
  queryCategorySamples(
    typeId: string,
    startDate: string,
    endDate: string,
  ): Promise<HealthKitSample[]>;
  queryClinicalRecords(
    typeId: string,
    startDate: string,
    endDate: string,
  ): Promise<ClinicalRecordSample[]>;
  queryWorkouts(startDate: string, endDate: string): Promise<WorkoutSample[]>;
  querySleepSamples(startDate: string, endDate: string): Promise<SleepSample[]>;
  queryWorkoutRoutes(workoutUuid: string): Promise<RouteLocation[]>;
}

/** Route data to push for a single workout */
export interface WorkoutRoutePayload {
  workoutUuid: string;
  sourceName?: string | null;
  locations: RouteLocation[];
}

/** Abstraction over tRPC client for testability */
export interface SyncTrpcClient {
  clinicalRecords: {
    push: {
      mutate(input: {
        records: Array<Omit<ClinicalRecordSample, "uuid"> & { externalId: string }>;
      }): Promise<{ upserted: number }>;
    };
  };
  healthKitSync: {
    recordSync: {
      mutate(input: {
        status: "success" | "degraded" | "error";
        recordCount: number;
        durationMs: number;
        errorMessage?: string;
        origin: "manual" | "unknown";
      }): Promise<{ recorded: true }>;
    };
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
    pushRunningStepSamples: {
      mutate(input: {
        workouts: WorkoutSample[];
        samples: RunningStepSample[];
      }): Promise<{ inserted: number }>;
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
  /**
   * App-owned manual operation context. Fixed window and checkpoint callbacks
   * replace the implicit window; omitted for the existing foreground callers.
   */
  manualExecution?: ManualHealthKitSyncContext;
}

/** Semantic manual stages. Identifiers are stable so they can be checkpointed. */
export type ManualHealthKitSyncStage =
  | "additive-and-category"
  | `raw:${string}`
  | "workouts"
  | "sleep"
  | `clinical:${string}`
  | "running-steps";

export interface ManualHealthKitSyncStageCompletion {
  stage: ManualHealthKitSyncStage;
  /** Number of contiguous stages known complete after this one. */
  completedStageCount: number;
  totalStageCount: number;
}

export interface ManualHealthKitSyncContext {
  /** Window requested when the operation started; resumes reuse it verbatim. */
  startDate: string;
  endDate: string;
  /** Semantic stage to start at; earlier stages are already complete. */
  nextStage: ManualHealthKitSyncStage;
  /** Awaited after a stage fully succeeds. A rejection stops the pipeline. */
  onStageComplete: (completion: ManualHealthKitSyncStageCompletion) => Promise<void>;
  /** Awaited before each query, upload, checkpoint, and anchor acknowledgement. */
  assertCanContinue: () => Promise<void>;
  /** Lets the manual owner recover only an observed background-crossing route transport error. */
  shouldRetryWorkoutRouteError: (error: unknown) => boolean;
}

/**
 * Expected control flow when the manual operation paused, expired, or lost its
 * account between two side effects. It is not an unexpected failure.
 */
export class ManualHealthKitSyncInterruptedError extends Error {
  constructor(message = "Apple Health sync was interrupted.") {
    super(message);
    this.name = "ManualHealthKitSyncInterruptedError";
  }
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
    | "queryCategorySamples"
    | "queryQuantitySamples"
    | "pushQuantitySamples"
    | "queryRunningStepSamples"
    | "queryRunningStepChanges"
    | "pushRunningStepSamples"
    | "queryWorkouts"
    | "pushWorkouts"
    | "queryWorkoutRoutes"
    | "pushWorkoutRoutes"
    | "querySleepSamples"
    | "pushSleepSamples"
    | "queryClinicalRecords"
    | "pushClinicalRecords";
  typeIdentifier?: string;
  batchIndex?: number;
  batchCount?: number;
  itemCount?: number;
}

export interface ObserverSyncOptions {
  trpcClient: SyncTrpcClient;
  healthKit: HealthKitAdapter;
  /** Device-wide lower bound retained across deleted accounts. */
  minimumSampleDate?: string | null;
  typeIdentifiers: readonly string[];
  onStage?: (stage: HealthKitSyncStage) => void;
  assertCanContinue?: () => Promise<void>;
}
