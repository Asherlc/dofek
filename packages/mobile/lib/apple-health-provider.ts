import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  completeAnchoredQuery,
  getRequestStatus,
  hasEverAuthorized,
  isAvailable,
  queryAnchoredSamples,
  queryDailyStatistics,
  queryQuantitySamples,
  querySleepSamples,
  queryWorkoutRoutes,
  queryWorkouts,
  requestPermissions,
} from "./platform-native/health";
import { loadDeviceErasureCutoff } from "./device-erasure-cutoff";
import {
  type HealthKitAdapter,
  type SyncOptions,
  type SyncResult,
  type SyncTrpcClient,
  syncHealthKitObserverChanges,
  syncHealthKitToServer,
} from "./health-kit-sync";
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
  lastSyncAt: null;
  importOnly: false;
  pushOnly: false;
}

export interface AppleHealthDisplayProvider {
  id: "apple_health";
  name: "Apple Health";
  authType: "none";
  authorized: boolean;
  importOnly: false;
  pushOnly: false;
  lastSyncedAt: null;
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
  }): Promise<SyncResult> {
    const minimumSampleDate = await this.#loadDeviceErasureCutoff();
    return this.#syncFunction({
      trpcClient: this.#trpcClient,
      healthKit: this.#healthKit,
      syncRangeDays: options.syncRangeDays,
      minimumSampleDate,
      onProgress: options.onProgress,
      onStage: options.onStage,
    });
  }

  async syncObserverChanges(options: {
    typeIdentifiers: readonly string[];
    onStage?: SyncOptions["onStage"];
  }): Promise<SyncResult> {
    const minimumSampleDate = await this.#loadDeviceErasureCutoff();
    return syncHealthKitObserverChanges({
      trpcClient: this.#trpcClient,
      healthKit: this.#healthKit,
      minimumSampleDate,
      typeIdentifiers: options.typeIdentifiers,
      onStage: options.onStage,
    });
  }
}

export class AppleHealthProviderModel {
  readonly authorizationState: AppleHealthAuthorizationState;
  #authorizationService: AppleHealthAuthorizationService;
  #syncService: AppleHealthSyncService;

  constructor(input: {
    authorizationState: AppleHealthAuthorizationState;
    authorizationService: AppleHealthAuthorizationService;
    syncService: AppleHealthSyncService;
  }) {
    this.authorizationState = input.authorizationState;
    this.#authorizationService = input.authorizationService;
    this.#syncService = input.syncService;
  }

  toProviderCard(): AppleHealthProviderCard {
    const connected = this.authorizationState.isConnected();
    return {
      id: "apple_health",
      label: "Apple Health",
      enabled: connected,
      authStatus: connected ? "connected" : "not_connected",
      authType: "none",
      lastSyncAt: null,
      importOnly: false,
      pushOnly: false,
    };
  }

  toDisplayProvider(): AppleHealthDisplayProvider {
    return {
      id: "apple_health",
      name: "Apple Health",
      authType: "none",
      authorized: this.authorizationState.isConnected(),
      importOnly: false,
      pushOnly: false,
      lastSyncedAt: null,
    };
  }

  shouldShowPermissionBanner(): boolean {
    return this.authorizationState.needsPermissionUpdate();
  }

  connect(): Promise<AppleHealthPermissionRequestResult> {
    return this.#authorizationService.requestPermissions();
  }

  sync(options: {
    syncRangeDays: number | null;
    onProgress?: (message: string) => void;
  }): Promise<SyncResult> {
    return this.#syncService.sync(options);
  }
}

export interface UseAppleHealthProviderModelOptions {
  trpcClient: AppleHealthTrpcClient;
  authorizationService?: AppleHealthAuthorizationService;
  syncService?: AppleHealthSyncService;
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
    syncService: inputSyncService,
    trpcClient,
    enabled = true,
    onAuthorizationError,
  } = options;
  const authorizationErrorHandlerRef = useRef(onAuthorizationError);
  const authorizationService = useMemo(
    () => inputAuthorizationService ?? new AppleHealthAuthorizationService(),
    [inputAuthorizationService],
  );
  const syncService = useMemo(
    () => inputSyncService ?? new AppleHealthSyncService({ trpcClient }),
    [inputSyncService, trpcClient],
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
        syncService,
      }),
    [authorizationState, authorizationService, syncService],
  );

  const connect = useCallback(async () => {
    const result = await model.connect();
    setAuthorizationState(result.state);
    return result;
  }, [model]);

  const sync = useCallback(
    (syncOptions: { syncRangeDays: number | null; onProgress?: (message: string) => void }) =>
      model.sync(syncOptions),
    [model],
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
  queryDailyStatistics,
  queryQuantitySamples,
  queryWorkouts,
  querySleepSamples,
  queryWorkoutRoutes,
};
