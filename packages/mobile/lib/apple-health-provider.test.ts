import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SyncResult } from "./health-kit-sync";

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
  queryQuantitySamples: vi.fn(async () => []),
  querySleepSamples: vi.fn(async () => []),
  queryWorkoutRoutes: vi.fn(async () => []),
  queryWorkouts: vi.fn(async () => []),
  requestPermissions: vi.fn(async () => true),
}));

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
    healthKitSync: {
      deleteQuantitySamples: {
        mutate: vi.fn(async () => ({ deleted: 0 })),
      },
      pushQuantitySamples: {
        mutate: vi.fn(async () => ({ inserted: 0, errors: [] })),
      },
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
  it("delegates sync with shared native adapter and tRPC client shape", async () => {
    const trpcClient = createTrpcClient();
    const syncResult: SyncResult = { deleted: 0, inserted: 2, errors: [] };
    const syncFunction = vi.fn<AppleHealthSyncFunction>(async () => syncResult);
    const service = new AppleHealthSyncService({
      loadDeviceErasureCutoff: vi.fn(async () => "2026-07-26T12:00:00.000Z"),
      trpcClient,
      healthKit: {
        queryDailyStatistics: vi.fn(async () => []),
        queryQuantitySamples: vi.fn(async () => []),
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
      syncService: new AppleHealthSyncService({ trpcClient: createTrpcClient() }),
    });

    expect(model.toProviderCard()).toEqual(
      expect.objectContaining({
        id: "apple_health",
        label: "Apple Health",
        enabled: true,
        authStatus: "connected",
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
        trpcClient: createTrpcClient(),
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
        trpcClient: createTrpcClient(),
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
});
