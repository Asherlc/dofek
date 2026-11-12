import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HealthKitManualSyncProvider } from "./health-kit-manual-sync-context";
import type { SyncResult } from "./health-kit-sync-types";
import { ManualHealthKitSyncInterruptedError } from "./health-kit-sync-types";

vi.mock("expo-crypto", () => ({ randomUUID: () => "test-uuid" }));

vi.mock("../modules/health-kit", () => ({
  completeAnchoredQuery: vi.fn(async () => true),
  getRequestStatus: vi.fn(async () => "shouldRequest"),
  hasEverAuthorized: vi.fn(() => false),
  isAvailable: vi.fn(() => true),
  queryAnchoredSamples: vi.fn(async () => ({
    queryId: null,
    samples: [],
    deletedUUIDs: [],
  })),
  queryDailyStatistics: vi.fn(async () => []),
  queryCategorySamples: vi.fn(async () => []),
  queryClinicalRecords: vi.fn(async () => []),
  queryQuantitySamples: vi.fn(async () => []),
  querySleepSamples: vi.fn(async () => []),
  queryWorkoutRoutes: vi.fn(async () => []),
  queryRunningStepSamples: vi.fn().mockResolvedValue({ workouts: [], samples: [] }),
  queryRunningStepChanges: vi.fn().mockResolvedValue({
    hasMore: false,
    workouts: [],
    samples: [],
    deletedUUIDs: [],
    queryId: null,
  }),
  queryWorkouts: vi.fn(async () => []),
  requestPermissions: vi.fn(async () => true),
}));

import { queryClinicalRecords, querySleepSamples } from "../modules/health-kit";
import {
  type AppleHealthAuthorizationNative,
  AppleHealthAuthorizationService,
  AppleHealthAuthorizationState,
  AppleHealthProviderModel,
  type AppleHealthSyncFunction,
  AppleHealthSyncService,
  type AppleHealthTrpcClient,
  useAppleHealthProviderModel,
} from "./apple-health-provider";

const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock("./telemetry", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

function createNative(overrides: Partial<AppleHealthAuthorizationNative> = {}) {
  return {
    isAvailable: vi.fn(() => true),
    hasEverAuthorized: vi.fn(() => false),
    getRequestStatus: vi.fn(async () => "shouldRequest" as const),
    requestPermissions: vi.fn(async () => true),
    ...overrides,
  };
}

function createTrpcClient(): AppleHealthTrpcClient {
  return {
    clinicalRecords: {
      push: {
        mutate: vi.fn(async () => ({ inserted: 0 })),
      },
    },
    healthKitSync: {
      recordSync: {
        mutate: vi.fn(async () => ({ recorded: true })),
      },
      deleteQuantitySamples: {
        mutate: vi.fn(async () => ({ deleted: 0 })),
      },
      pushQuantitySamples: {
        mutate: vi.fn(async () => ({ inserted: 0, errors: [] })),
      },
      pushRunningStepSamples: { mutate: vi.fn().mockResolvedValue({ inserted: 0 }) },
      pushWorkouts: {
        mutate: vi.fn(async () => ({ inserted: 0 })),
      },
      pushWorkoutRoutes: {
        mutate: vi.fn(async () => ({ inserted: 0 })),
      },
      pushSleepSamples: {
        mutate: vi.fn(async () => ({ inserted: 0 })),
      },
    },
  };
}

describe("AppleHealthAuthorizationState", () => {
  it("is connected when the current HealthKit request is unnecessary even if the legacy marker is false", () => {
    const state = new AppleHealthAuthorizationState({
      available: true,
      hasCompletedAuthorizationFlow: false,
      requestStatus: "unnecessary",
    });

    expect(state.isConnected()).toBe(true);
    expect(state.canAttemptSync()).toBe(true);
    expect(state.needsPermissionUpdate()).toBe(false);
  });

  it("is not connected when HealthKit still needs an initial authorization request", () => {
    const state = new AppleHealthAuthorizationState({
      available: true,
      hasCompletedAuthorizationFlow: false,
      requestStatus: "shouldRequest",
    });

    expect(state.isConnected()).toBe(false);
    expect(state.canAttemptSync()).toBe(true);
    expect(state.needsPermissionUpdate()).toBe(false);
  });

  it("needs a permission update when a previously authorized user has new permission types", () => {
    const state = new AppleHealthAuthorizationState({
      available: true,
      hasCompletedAuthorizationFlow: true,
      requestStatus: "shouldRequest",
    });

    expect(state.isConnected()).toBe(true);
    expect(state.needsPermissionUpdate()).toBe(true);
  });

  it("cannot attempt sync when HealthKit is unavailable", () => {
    const state = new AppleHealthAuthorizationState({
      available: false,
      hasCompletedAuthorizationFlow: true,
      requestStatus: "unavailable",
    });

    expect(state.isConnected()).toBe(false);
    expect(state.canAttemptSync()).toBe(false);
  });
});

describe("AppleHealthAuthorizationService", () => {
  it("resolves unavailable state without requesting HealthKit status", async () => {
    const native = createNative({ isAvailable: vi.fn(() => false) });
    const service = new AppleHealthAuthorizationService(native);

    const state = await service.resolve();

    expect(state.available).toBe(false);
    expect(state.requestStatus).toBe("unavailable");
    expect(native.getRequestStatus).not.toHaveBeenCalled();
  });

  it("resolves marker and current request status when HealthKit is available", async () => {
    const native = createNative({
      hasEverAuthorized: vi.fn(() => false),
      getRequestStatus: vi.fn(async () => "unnecessary" as const),
    });
    const service = new AppleHealthAuthorizationService(native);

    const state = await service.resolve();

    expect(state.hasCompletedAuthorizationFlow).toBe(false);
    expect(state.requestStatus).toBe("unnecessary");
    expect(state.isConnected()).toBe(true);
  });

  it("requests permissions and returns refreshed authorization state", async () => {
    const native = createNative({
      hasEverAuthorized: vi.fn(() => true),
      getRequestStatus: vi.fn(async () => "unnecessary" as const),
    });
    const service = new AppleHealthAuthorizationService(native);

    const result = await service.requestPermissions();

    expect(native.requestPermissions).toHaveBeenCalledOnce();
    expect(result.granted).toBe(true);
    expect(result.state.isConnected()).toBe(true);
  });
});

describe("AppleHealthSyncService", () => {
  beforeEach(() => {
    mockCaptureException.mockClear();
  });

  it("records a successful manual sync after HealthKit data is uploaded", async () => {
    const trpcClient = createTrpcClient();
    const syncFunction = vi.fn<AppleHealthSyncFunction>(async () => ({
      deleted: 3,
      inserted: 39,
      errors: [],
    }));
    const service = new AppleHealthSyncService({
      trpcClient,
      loadDeviceErasureCutoff: vi.fn(async () => null),
      syncFunction,
    });

    await service.sync({ syncRangeDays: 7 });

    expect(trpcClient.healthKitSync.recordSync.mutate).toHaveBeenCalledWith({
      status: "success",
      recordCount: 42,
      durationMs: expect.any(Number),
      origin: "manual",
    });
  });

  it("returns a successful sync when recording its history fails", async () => {
    const trpcClient = createTrpcClient();
    const recordError = new Error("Sync history unavailable");
    trpcClient.healthKitSync.recordSync.mutate = vi.fn().mockRejectedValue(recordError);
    const syncResult: SyncResult = { deleted: 0, inserted: 2, errors: [] };
    const service = new AppleHealthSyncService({
      trpcClient,
      loadDeviceErasureCutoff: vi.fn(async () => null),
      syncFunction: vi.fn<AppleHealthSyncFunction>(async () => syncResult),
    });

    await expect(service.sync({ syncRangeDays: 7 })).resolves.toEqual(syncResult);

    expect(mockCaptureException).toHaveBeenCalledWith(recordError, {
      source: "apple-health-sync-log",
      origin: "manual",
    });
  });

  it("records a failed manual sync before rethrowing the upload error", async () => {
    const trpcClient = createTrpcClient();
    const syncError = new Error("HealthKit upload failed");
    const syncFunction = vi.fn<AppleHealthSyncFunction>().mockRejectedValue(syncError);
    const service = new AppleHealthSyncService({
      trpcClient,
      loadDeviceErasureCutoff: vi.fn(async () => null),
      syncFunction,
    });

    await expect(service.sync({ syncRangeDays: 7 })).rejects.toBe(syncError);
    expect(trpcClient.healthKitSync.recordSync.mutate).toHaveBeenCalledWith({
      status: "error",
      recordCount: 0,
      durationMs: expect.any(Number),
      errorMessage: "HealthKit upload failed",
      origin: "manual",
    });
    expect(mockCaptureException).toHaveBeenCalledWith(syncError, {
      source: "apple-health-sync",
      origin: "manual",
    });
  });

  it("does not record or capture a manual pause as a failed sync", async () => {
    const trpcClient = createTrpcClient();
    const interrupted = new ManualHealthKitSyncInterruptedError();
    const service = new AppleHealthSyncService({
      trpcClient,
      loadDeviceErasureCutoff: vi.fn(async () => null),
      syncFunction: vi.fn<AppleHealthSyncFunction>().mockRejectedValue(interrupted),
    });

    await expect(service.sync({ syncRangeDays: null })).rejects.toBe(interrupted);
    expect(trpcClient.healthKitSync.recordSync.mutate).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("does not record or capture observer work interrupted by account retirement", async () => {
    const trpcClient = createTrpcClient();
    const interrupted = new ManualHealthKitSyncInterruptedError();
    const service = new AppleHealthSyncService({
      trpcClient,
      loadDeviceErasureCutoff: vi.fn(async () => null),
      syncFunction: vi.fn<AppleHealthSyncFunction>(),
    });

    await expect(
      service.syncObserverChanges({
        typeIdentifiers: ["HKQuantityTypeIdentifierHeartRate"],
        assertCanContinue: async () => {
          throw interrupted;
        },
      }),
    ).rejects.toBe(interrupted);
    expect(trpcClient.healthKitSync.recordSync.mutate).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("does not record observer success after retirement during the final upload", async () => {
    vi.mocked(querySleepSamples).mockClear();
    const trpcClient = createTrpcClient();
    const upload = Promise.withResolvers<{ inserted: number }>();
    const retirement = new ManualHealthKitSyncInterruptedError();
    let retired = false;
    vi.mocked(querySleepSamples).mockResolvedValueOnce([
      {
        uuid: "sleep-1",
        startDate: "2026-03-22T22:00:00Z",
        endDate: "2026-03-23T06:00:00Z",
        value: "asleep",
        sourceName: "Apple Watch",
      },
    ]);
    trpcClient.healthKitSync.pushSleepSamples.mutate.mockReturnValueOnce(upload.promise);
    const service = new AppleHealthSyncService({
      trpcClient,
      loadDeviceErasureCutoff: vi.fn(async () => null),
    });
    const sync = service.syncObserverChanges({
      typeIdentifiers: ["HKCategoryTypeIdentifierSleepAnalysis"],
      assertCanContinue: async () => {
        if (retired) throw retirement;
      },
    });
    await vi.waitFor(() =>
      expect(trpcClient.healthKitSync.pushSleepSamples.mutate).toHaveBeenCalledOnce(),
    );
    retired = true;
    upload.resolve({ inserted: 1 });

    await expect(sync).rejects.toBe(retirement);
    expect(trpcClient.healthKitSync.recordSync.mutate).not.toHaveBeenCalled();
  });

  it("does not record an observer query failure that settles after retirement", async () => {
    vi.mocked(querySleepSamples).mockClear();
    const trpcClient = createTrpcClient();
    const query = Promise.withResolvers<Awaited<ReturnType<typeof querySleepSamples>>>();
    const retirement = new ManualHealthKitSyncInterruptedError();
    let retired = false;
    vi.mocked(querySleepSamples).mockReturnValueOnce(query.promise);
    const service = new AppleHealthSyncService({
      trpcClient,
      loadDeviceErasureCutoff: vi.fn(async () => null),
    });
    const sync = service.syncObserverChanges({
      typeIdentifiers: ["HKCategoryTypeIdentifierSleepAnalysis"],
      assertCanContinue: async () => {
        if (retired) throw retirement;
      },
    });
    await vi.waitFor(() => expect(querySleepSamples).toHaveBeenCalledOnce());
    retired = true;
    query.reject(new Error("late HealthKit query failure"));

    await expect(sync).rejects.toBe(retirement);
    expect(trpcClient.healthKitSync.recordSync.mutate).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("propagates retirement detected at the observer error-record guard", async () => {
    vi.mocked(querySleepSamples).mockClear();
    const trpcClient = createTrpcClient();
    const interrupted = new ManualHealthKitSyncInterruptedError();
    let ownershipChecks = 0;
    vi.mocked(querySleepSamples).mockRejectedValueOnce(
      new Error("fetch failed: The request timed out."),
    );
    const service = new AppleHealthSyncService({
      trpcClient,
      loadDeviceErasureCutoff: vi.fn(async () => null),
    });

    await expect(
      service.syncObserverChanges({
        typeIdentifiers: ["HKCategoryTypeIdentifierSleepAnalysis"],
        assertCanContinue: async () => {
          ownershipChecks += 1;
          if (ownershipChecks === 3) throw interrupted;
        },
      }),
    ).rejects.toBe(interrupted);

    expect(ownershipChecks).toBe(3);
    expect(trpcClient.healthKitSync.recordSync.mutate).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("records a partial manual sync as degraded with its errors", async () => {
    const trpcClient = createTrpcClient();
    const syncFunction = vi.fn<AppleHealthSyncFunction>(async () => ({
      deleted: 0,
      inserted: 4,
      errors: ["Route query failed"],
    }));
    const service = new AppleHealthSyncService({
      trpcClient,
      loadDeviceErasureCutoff: vi.fn(async () => null),
      syncFunction,
    });

    await service.sync({ syncRangeDays: 7 });

    expect(trpcClient.healthKitSync.recordSync.mutate).toHaveBeenCalledWith({
      status: "degraded",
      recordCount: 4,
      durationMs: expect.any(Number),
      errorMessage: "Route query failed",
      origin: "manual",
    });
  });

  it("forwards clinical-record queries through the default native adapter", async () => {
    const records = [
      {
        uuid: "659ee585-b399-4c21-841f-97fe49fdc465",
        clinicalType: "condition" as const,
        displayName: "Migraine",
        sourceName: "Example Health System",
        fhirVersion: "4.0.1",
        fhir: { resourceType: "Condition" },
        downloadedAt: "2026-04-25T17:15:30.000Z",
      },
    ];
    vi.mocked(queryClinicalRecords).mockResolvedValueOnce(records);
    const syncFunction = vi.fn<AppleHealthSyncFunction>(async ({ healthKit }) => {
      const queriedRecords = await healthKit.queryClinicalRecords(
        "HKClinicalTypeIdentifierConditionRecord",
        "2026-04-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
      );
      return { deleted: 0, inserted: queriedRecords.length, errors: [] };
    });
    const service = new AppleHealthSyncService({
      trpcClient: createTrpcClient(),
      loadDeviceErasureCutoff: vi.fn(async () => null),
      syncFunction,
    });

    await expect(service.sync({ syncRangeDays: 7 })).resolves.toEqual({
      deleted: 0,
      inserted: 1,
      errors: [],
    });
    expect(queryClinicalRecords).toHaveBeenCalledWith(
      "HKClinicalTypeIdentifierConditionRecord",
      "2026-04-01T00:00:00.000Z",
      "2026-05-01T00:00:00.000Z",
    );
  });

  it("delegates sync with shared native adapter and tRPC client shape", async () => {
    const trpcClient = createTrpcClient();
    const syncResult: SyncResult = { deleted: 0, inserted: 2, errors: [] };
    const syncFunction = vi.fn<AppleHealthSyncFunction>(async () => syncResult);
    const service = new AppleHealthSyncService({
      loadDeviceErasureCutoff: vi.fn(async () => "2026-07-26T12:00:00.000Z"),
      trpcClient,
      healthKit: {
        queryClinicalRecords: vi.fn(async () => []),
        queryDailyStatistics: vi.fn(async () => []),
        queryCategorySamples: vi.fn(async () => []),
        queryQuantitySamples: vi.fn(async () => []),
        queryRunningStepSamples: vi.fn().mockResolvedValue({ workouts: [], samples: [] }),
        queryRunningStepChanges: vi.fn().mockResolvedValue({
          hasMore: false,
          workouts: [],
          samples: [],
          deletedUUIDs: [],
          queryId: null,
        }),
        queryWorkouts: vi.fn(async () => []),
        querySleepSamples: vi.fn(async () => []),
        queryWorkoutRoutes: vi.fn(async () => []),
      },
      syncFunction,
    });
    const onProgress = vi.fn();

    const result = await service.sync({ syncRangeDays: 1, onProgress });

    expect(result).toEqual(syncResult);
    expect(syncFunction).toHaveBeenCalledWith(
      expect.objectContaining({
        syncRangeDays: 1,
        minimumSampleDate: "2026-07-26T12:00:00.000Z",
        onProgress,
        trpcClient: expect.objectContaining({
          healthKitSync: expect.objectContaining({
            pushWorkouts: expect.objectContaining({ mutate: expect.any(Function) }),
          }),
        }),
      }),
    );
  });

  it("fails closed without querying HealthKit when the cutoff cannot be loaded", async () => {
    const syncFunction = vi.fn<AppleHealthSyncFunction>();
    const service = new AppleHealthSyncService({
      loadDeviceErasureCutoff: vi.fn().mockRejectedValue(new Error("SecureStore unavailable")),
      syncFunction,
      trpcClient: createTrpcClient(),
    });

    await expect(service.sync({ syncRangeDays: 1 })).rejects.toThrow("SecureStore unavailable");
    expect(syncFunction).not.toHaveBeenCalled();
  });
});

describe("AppleHealthProviderModel", () => {
  it("creates connected provider card and display provider state from authorization", () => {
    const state = new AppleHealthAuthorizationState({
      available: true,
      hasCompletedAuthorizationFlow: false,
      requestStatus: "unnecessary",
    });
    const model = new AppleHealthProviderModel({
      authorizationState: state,
      authorizationService: new AppleHealthAuthorizationService(createNative()),
    });

    expect(model.toProviderCard()).toEqual(
      expect.objectContaining({
        id: "apple_health",
        label: "Apple Health",
        enabled: true,
        authStatus: "connected",
        recentLogs: [],
      }),
    );
    expect(model.toDisplayProvider()).toEqual(
      expect.objectContaining({
        id: "apple_health",
        name: "Apple Health",
        authorized: true,
      }),
    );
  });

  it("includes native sync history in the provider card state", () => {
    const model = new AppleHealthProviderModel({
      authorizationState: AppleHealthAuthorizationState.unknown(),
      authorizationService: new AppleHealthAuthorizationService(createNative()),
    });
    const syncLog = {
      id: "apple-health-sync-1",
      providerId: "apple_health",
      dataType: "sync",
      status: "success",
      recordCount: 42,
      durationMs: 1_250,
      errorMessage: null,
      authFailureReason: null,
      syncedAt: "2026-09-12T15:00:00Z",
    };

    expect(
      model.toProviderCard({
        lastSyncAt: syncLog.syncedAt,
        lastSuccessfulSyncAt: syncLog.syncedAt,
        recentLogs: [syncLog],
      }),
    ).toEqual(
      expect.objectContaining({
        lastSyncAt: syncLog.syncedAt,
        lastSuccessfulSyncAt: syncLog.syncedAt,
        recentLogs: [syncLog],
      }),
    );
  });
});

describe("useAppleHealthProviderModel", () => {
  beforeEach(() => {
    mockCaptureException.mockClear();
  });

  it("refreshes authorization state on mount", async () => {
    const native = createNative({
      getRequestStatus: vi.fn(async () => "unnecessary" as const),
    });

    const { result } = renderHook(() =>
      useAppleHealthProviderModel({
        authorizationService: new AppleHealthAuthorizationService(native),
      }),
    );

    await waitFor(() => {
      expect(result.current.authorizationState.isConnected()).toBe(true);
    });
  });

  it("reports and handles mount-time authorization refresh failures", async () => {
    const authorizationError = new Error("HealthKit status failed");
    const onAuthorizationError = vi.fn();
    const native = createNative({
      getRequestStatus: vi.fn(async () => {
        throw authorizationError;
      }),
    });

    renderHook(() =>
      useAppleHealthProviderModel({
        authorizationService: new AppleHealthAuthorizationService(native),
        onAuthorizationError,
      }),
    );

    await waitFor(() => {
      expect(mockCaptureException).toHaveBeenCalledWith(authorizationError, {
        source: "apple-health-authorization-refresh",
      });
    });
    expect(onAuthorizationError).toHaveBeenCalledWith(authorizationError);
  });

  it("routes manual sync through the authenticated root controller", async () => {
    const syncResult = { deleted: 0, inserted: 3, errors: [] };
    const idleSnapshot = {
      status: "idle" as const,
      message: null,
      completedStageCount: 0,
      totalStageCount: 0,
      error: null,
    };
    const controller = {
      getSnapshot: () => idleSnapshot,
      subscribe: () => () => undefined,
      start: vi.fn(async () => syncResult),
    } satisfies NonNullable<Parameters<typeof HealthKitManualSyncProvider>[0]["controller"]>;
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(HealthKitManualSyncProvider, { controller }, children);
    const { result } = renderHook(() => useAppleHealthProviderModel({}), {
      wrapper,
    });

    await waitFor(async () => {
      await expect(result.current.sync({ syncRangeDays: 7 })).resolves.toEqual(syncResult);
      expect(controller.start).toHaveBeenCalledWith(7);
    });
  });
});
