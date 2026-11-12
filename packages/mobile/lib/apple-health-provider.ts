import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  completeAnchoredQuery,
  getRequestStatus,
  hasEverAuthorized,
  isAvailable,
  queryAnchoredSamples,
  queryCategorySamples,
  queryClinicalRecords,
  queryDailyStatistics,
  queryQuantitySamples,
  queryRunningStepChanges,
  queryRunningStepSamples,
  querySleepSamples,
  queryWorkoutRoutes,
  queryWorkouts,
  requestPermissions,
} from "../modules/health-kit";
import { loadDeviceErasureCutoff } from "./device-erasure-cutoff";
import {
  isBackgroundHealthKitTransientNetworkError,
  isHealthKitDatabaseInaccessible,
} from "./health-kit-errors";
import { useHealthKitManualSync } from "./health-kit-manual-sync-context";
import { syncHealthKitObserverChanges, syncHealthKitToServer } from "./health-kit-sync";
import type {
  HealthKitAdapter,
  ManualHealthKitSyncContext,
  SyncOptions,
  SyncResult,
  SyncTrpcClient,
} from "./health-kit-sync-types";
import { ManualHealthKitSyncInterruptedError } from "./health-kit-sync-types";
import { captureException } from "./telemetry";

export type AppleHealthRequestStatus = "unnecessary" | "shouldRequest" | "unavailable" | "unknown";

export interface AppleHealthAuthorizationNative {
  isAvailable(): boolean;
  hasEverAuthorized(): boolean;
  getRequestStatus(): Promise<AppleHealthRequestStatus>;
  requestPermissions(): Promise<boolean>;
}

export interface AppleHealthPermissionRequestResult {
  granted: boolean;
  state: AppleHealthAuthorizationState;
}

export interface AppleHealthProviderCard {
  id: "apple_health";
  label: "Apple Health";
  enabled: boolean;
  authStatus: "connected" | "not_connected";
  authType: "none";
  lastSyncAt: string | null;
  lastSuccessfulSyncAt: string | null;
  syncFreshness: null;
  importOnly: false;
  pushOnly: false;
  recentLogs: Array<{
    id: string;
    providerId: string;
    dataType: string;
    status: string;
    recordCount: number | null;
    durationMs: number | null;
    errorMessage: string | null;
    authFailureReason: string | null;
    syncedAt: string;
  }>;
}

export interface AppleHealthSyncStatus {
  lastSyncAt: string | null;
  lastSuccessfulSyncAt: string | null;
  recentLogs: AppleHealthProviderCard["recentLogs"];
}

export interface AppleHealthDisplayProvider {
  id: "apple_health";
  name: "Apple Health";
  authType: "none";
  authorized: boolean;
  importOnly: false;
  pushOnly: false;
  lastSyncedAt: string | null;
}

export type AppleHealthTrpcClient = SyncTrpcClient;
export type AppleHealthSyncFunction = (options: SyncOptions) => Promise<SyncResult>;

export class AppleHealthAuthorizationState {
  readonly available: boolean;
  readonly hasCompletedAuthorizationFlow: boolean;
  readonly requestStatus: AppleHealthRequestStatus;

  constructor(input: {
    available: boolean;
    hasCompletedAuthorizationFlow: boolean;
    requestStatus: AppleHealthRequestStatus;
  }) {
    this.available = input.available;
    this.hasCompletedAuthorizationFlow = input.hasCompletedAuthorizationFlow;
    this.requestStatus = input.requestStatus;
  }

  static unknown(): AppleHealthAuthorizationState {
    return new AppleHealthAuthorizationState({
      available: false,
      hasCompletedAuthorizationFlow: false,
      requestStatus: "unknown",
    });
  }

  isConnected(): boolean {
    return (
      this.available && (this.hasCompletedAuthorizationFlow || this.requestStatus === "unnecessary")
    );
  }

  needsPermissionUpdate(): boolean {
    return (
      this.available && this.hasCompletedAuthorizationFlow && this.requestStatus === "shouldRequest"
    );
  }

  canAttemptSync(): boolean {
    return this.available;
  }
}

export class AppleHealthAuthorizationService {
  #native: AppleHealthAuthorizationNative;

  constructor(native: AppleHealthAuthorizationNative = defaultAppleHealthAuthorizationNative) {
    this.#native = native;
  }

  async resolve(): Promise<AppleHealthAuthorizationState> {
    const available = this.#native.isAvailable();
    if (!available) {
      return new AppleHealthAuthorizationState({
        available: false,
        hasCompletedAuthorizationFlow: false,
        requestStatus: "unavailable",
      });
    }

    const hasCompletedAuthorizationFlow = this.#native.hasEverAuthorized();
    const requestStatus = await this.#native.getRequestStatus();
    return new AppleHealthAuthorizationState({
      available,
      hasCompletedAuthorizationFlow,
      requestStatus,
    });
  }

  async requestPermissions(): Promise<AppleHealthPermissionRequestResult> {
    const granted = await this.#native.requestPermissions();
    const state = await this.resolve();
    return { granted, state };
  }
}

export class AppleHealthSyncService {
  #trpcClient: AppleHealthTrpcClient;
  #healthKit: HealthKitAdapter;
  #loadDeviceErasureCutoff: () => Promise<string | null>;
  #syncFunction: AppleHealthSyncFunction;

  constructor(input: {
    trpcClient: AppleHealthTrpcClient;
    healthKit?: HealthKitAdapter;
    loadDeviceErasureCutoff?: () => Promise<string | null>;
    syncFunction?: AppleHealthSyncFunction;
  }) {
    this.#trpcClient = input.trpcClient;
    this.#healthKit = input.healthKit ?? defaultAppleHealthAdapter;
    this.#loadDeviceErasureCutoff = input.loadDeviceErasureCutoff ?? loadDeviceErasureCutoff;
    this.#syncFunction = input.syncFunction ?? syncHealthKitToServer;
  }

  async sync(options: {
    syncRangeDays: number | null;
    onProgress?: (message: string) => void;
    onStage?: SyncOptions["onStage"];
    manualExecution?: ManualHealthKitSyncContext;
  }): Promise<SyncResult> {
    return this.#runAndRecordSync("manual", async () => {
      const minimumSampleDate = await this.#loadDeviceErasureCutoff();
      return this.#syncFunction({
        trpcClient: this.#trpcClient,
        healthKit: this.#healthKit,
        syncRangeDays: options.syncRangeDays,
        minimumSampleDate,
        onProgress: options.onProgress,
        onStage: options.onStage,
        manualExecution: options.manualExecution,
      });
    });
  }

  /** Runs one resumable attempt without logging pauses or retryable interruptions. */
  async syncManualCheckpointed(options: {
    syncRangeDays: number | null;
    onProgress?: (message: string) => void;
    onStage?: SyncOptions["onStage"];
    manualExecution: ManualHealthKitSyncContext;
  }): Promise<SyncResult> {
    const minimumSampleDate = await this.#loadDeviceErasureCutoff();
    return this.#syncFunction({
      trpcClient: this.#trpcClient,
      healthKit: this.#healthKit,
      syncRangeDays: options.syncRangeDays,
      minimumSampleDate,
      onProgress: options.onProgress,
      onStage: options.onStage,
      manualExecution: options.manualExecution,
    });
  }

  /** Writes the single terminal log entry after the controller settles retries and pauses. */
  async recordManualOutcome(
    result: SyncResult | null,
    error: unknown | null,
    durationMs: number,
  ): Promise<void> {
    try {
      await this.#trpcClient.healthKitSync.recordSync.mutate({
        status: error ? "error" : result?.errors.length ? "degraded" : "success",
        recordCount: result ? result.inserted + result.deleted : 0,
        durationMs,
        ...(error ? { errorMessage: error instanceof Error ? error.message : String(error) } : {}),
        ...(result?.errors.length ? { errorMessage: result.errors.join("; ") } : {}),
        origin: "manual",
      });
    } catch (recordError) {
      captureException(recordError, { source: "apple-health-sync-log", origin: "manual" });
    }
  }

  async syncObserverChanges(options: {
    typeIdentifiers: readonly string[];
    onStage?: SyncOptions["onStage"];
    assertCanContinue?: () => Promise<void>;
  }): Promise<SyncResult> {
    return this.#runAndRecordSync("unknown", async () => {
      const minimumSampleDate = await this.#loadDeviceErasureCutoff();
      return syncHealthKitObserverChanges({
        trpcClient: this.#trpcClient,
        healthKit: this.#healthKit,
        minimumSampleDate,
        typeIdentifiers: options.typeIdentifiers,
        onStage: options.onStage,
        assertCanContinue: options.assertCanContinue,
      });
    });
  }

  async #runAndRecordSync(
    origin: "manual" | "unknown",
    operation: () => Promise<SyncResult>,
  ): Promise<SyncResult> {
    const startedAt = Date.now();
    let result: SyncResult;
    try {
      result = await operation();
    } catch (error) {
      if (error instanceof ManualHealthKitSyncInterruptedError) {
        throw error;
      }
      if (origin === "manual" && isHealthKitDatabaseInaccessible(error)) {
        throw error;
      }
      const isExpectedBackgroundFailure =
        origin === "unknown" && isBackgroundHealthKitTransientNetworkError(error);
      if (!isHealthKitDatabaseInaccessible(error) && !isExpectedBackgroundFailure) {
        captureException(error, { source: "apple-health-sync", origin });
      }
      try {
        await this.#trpcClient.healthKitSync.recordSync.mutate({
          status: "error",
          recordCount: 0,
          durationMs: Date.now() - startedAt,
          errorMessage: error instanceof Error ? error.message : String(error),
          origin,
        });
      } catch (recordError) {
        captureException(recordError, { source: "apple-health-sync-log", origin });
      }
      throw error;
    }

    try {
      await this.#trpcClient.healthKitSync.recordSync.mutate({
        status: result.errors.length > 0 ? "degraded" : "success",
        recordCount: result.inserted + result.deleted,
        durationMs: Date.now() - startedAt,
        ...(result.errors.length > 0 ? { errorMessage: result.errors.join("; ") } : {}),
        origin,
      });
    } catch (recordError) {
      captureException(recordError, { source: "apple-health-sync-log", origin });
    }
    return result;
  }
}

export class AppleHealthProviderModel {
  readonly authorizationState: AppleHealthAuthorizationState;
  #authorizationService: AppleHealthAuthorizationService;

  constructor(input: {
    authorizationState: AppleHealthAuthorizationState;
    authorizationService: AppleHealthAuthorizationService;
  }) {
    this.authorizationState = input.authorizationState;
    this.#authorizationService = input.authorizationService;
  }

  toProviderCard(syncStatus?: AppleHealthSyncStatus): AppleHealthProviderCard {
    const connected = this.authorizationState.isConnected();
    return {
      id: "apple_health",
      label: "Apple Health",
      enabled: connected,
      authStatus: connected ? "connected" : "not_connected",
      authType: "none",
      lastSyncAt: syncStatus?.lastSyncAt ?? null,
      lastSuccessfulSyncAt: syncStatus?.lastSuccessfulSyncAt ?? null,
      syncFreshness: null,
      importOnly: false,
      pushOnly: false,
      recentLogs: syncStatus?.recentLogs ?? [],
    };
  }

  toDisplayProvider(input: { lastSyncedAt?: string | null } = {}): AppleHealthDisplayProvider {
    return {
      id: "apple_health",
      name: "Apple Health",
      authType: "none",
      authorized: this.authorizationState.isConnected(),
      importOnly: false,
      pushOnly: false,
      lastSyncedAt: input.lastSyncedAt ?? null,
    };
  }

  shouldShowPermissionBanner(): boolean {
    return this.authorizationState.needsPermissionUpdate();
  }

  connect(): Promise<AppleHealthPermissionRequestResult> {
    return this.#authorizationService.requestPermissions();
  }
}

export interface UseAppleHealthProviderModelOptions {
  authorizationService?: AppleHealthAuthorizationService;
  enabled?: boolean;
  onAuthorizationError?: (error: unknown) => void;
}

export interface UseAppleHealthProviderModelResult {
  authorizationState: AppleHealthAuthorizationState;
  model: AppleHealthProviderModel;
  refreshAuthorizationState(): Promise<AppleHealthAuthorizationState>;
  connect(): Promise<AppleHealthPermissionRequestResult>;
  sync(options: {
    syncRangeDays: number | null;
    onProgress?: (message: string) => void;
  }): Promise<SyncResult>;
}

export function useAppleHealthProviderModel(
  options: UseAppleHealthProviderModelOptions,
): UseAppleHealthProviderModelResult {
  const {
    authorizationService: inputAuthorizationService,
    enabled = true,
    onAuthorizationError,
  } = options;
  const contextualManualSync = useHealthKitManualSync().controller;
  const manualSyncController = contextualManualSync;
  const authorizationErrorHandlerRef = useRef(onAuthorizationError);
  const authorizationService = useMemo(
    () => inputAuthorizationService ?? new AppleHealthAuthorizationService(),
    [inputAuthorizationService],
  );
  const [authorizationState, setAuthorizationState] = useState(() =>
    AppleHealthAuthorizationState.unknown(),
  );

  useEffect(() => {
    authorizationErrorHandlerRef.current = onAuthorizationError;
  }, [onAuthorizationError]);

  const refreshAuthorizationState = useCallback(async () => {
    if (!enabled) {
      return AppleHealthAuthorizationState.unknown();
    }
    try {
      const resolvedState = await authorizationService.resolve();
      setAuthorizationState(resolvedState);
      return resolvedState;
    } catch (error) {
      captureException(error, { source: "apple-health-authorization-refresh" });
      authorizationErrorHandlerRef.current?.(error);
      const unknownState = AppleHealthAuthorizationState.unknown();
      setAuthorizationState(unknownState);
      return unknownState;
    }
  }, [authorizationService, enabled]);

  useEffect(() => {
    if (!enabled) return;
    void refreshAuthorizationState();
  }, [enabled, refreshAuthorizationState]);

  const model = useMemo(
    () =>
      new AppleHealthProviderModel({
        authorizationState,
        authorizationService,
      }),
    [authorizationState, authorizationService],
  );

  const connect = useCallback(async () => {
    const result = await model.connect();
    setAuthorizationState(result.state);
    return result;
  }, [model]);

  const sync = useCallback(
    (syncOptions: { syncRangeDays: number | null; onProgress?: (message: string) => void }) => {
      if (!manualSyncController) {
        return Promise.reject(new Error("Apple Health sync is unavailable for this account."));
      }
      return manualSyncController.start(syncOptions.syncRangeDays);
    },
    [manualSyncController],
  );

  return {
    authorizationState,
    model,
    refreshAuthorizationState,
    connect,
    sync,
  };
}

export const defaultAppleHealthAuthorizationNative: AppleHealthAuthorizationNative = {
  isAvailable,
  hasEverAuthorized,
  getRequestStatus,
  requestPermissions,
};

export const defaultAppleHealthAdapter: HealthKitAdapter = {
  completeAnchoredQuery,
  queryAnchoredSamples,
  queryCategorySamples,
  queryClinicalRecords: (typeIdentifier, startDate, endDate) =>
    queryClinicalRecords(typeIdentifier, startDate, endDate),
  queryDailyStatistics,
  queryQuantitySamples,
  queryWorkouts,
  queryRunningStepSamples,
  queryRunningStepChanges,
  querySleepSamples,
  queryWorkoutRoutes,
};
