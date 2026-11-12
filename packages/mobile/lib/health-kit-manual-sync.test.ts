import * as Network from "expo-network";
import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  InvalidManualHealthKitCheckpointError,
  type ManualHealthKitCheckpoint,
} from "./health-kit-manual-checkpoint";
import {
  HealthKitManualSyncController,
  type HealthKitManualSyncDependencies,
} from "./health-kit-manual-sync";
import type { SyncTrpcClient } from "./health-kit-sync-types";

vi.mock("expo-crypto", () => ({ randomUUID: () => "test-uuid" }));

vi.mock("../modules/background-refresh", () => ({
  addHealthKitSyncExpirationListener: vi.fn(() => ({ remove: vi.fn() })),
  completeHealthKitSync: vi.fn(),
  startHealthKitSync: vi.fn(async () => ({ supported: true })),
  updateHealthKitSyncProgress: vi.fn(),
}));
const { mockCaptureException } = vi.hoisted(() => ({ mockCaptureException: vi.fn() }));
vi.mock("./telemetry", () => ({ captureException: mockCaptureException }));
vi.mock("expo-network", () => ({
  addNetworkStateListener: vi.fn(() => ({ remove: vi.fn() })),
  getNetworkStateAsync: vi.fn(async () => ({ isConnected: true, isInternetReachable: true })),
}));
const { mockDefaultRunSync } = vi.hoisted(() => ({ mockDefaultRunSync: vi.fn() }));
vi.mock("./apple-health-provider", () => ({
  AppleHealthSyncService: class {
    syncManualCheckpointed(input: unknown) {
      return mockDefaultRunSync(input);
    }
    recordManualOutcome() {
      return Promise.resolve();
    }
  },
}));

const unusedTestClient = {
  clinicalRecords: { push: { mutate: async () => ({ upserted: 0 }) } },
  healthKitSync: {
    recordSync: { mutate: async (): Promise<{ recorded: true }> => ({ recorded: true }) },
    deleteQuantitySamples: { mutate: async () => ({ deleted: 0 }) },
    pushQuantitySamples: { mutate: async () => ({ inserted: 0, errors: [] }) },
    pushRunningStepSamples: { mutate: async () => ({ inserted: 0 }) },
    pushWorkouts: { mutate: async () => ({ inserted: 0 }) },
    pushWorkoutRoutes: { mutate: async () => ({ inserted: 0 }) },
    pushSleepSamples: { mutate: async () => ({ inserted: 0 }) },
  },
} satisfies SyncTrpcClient;

function makeHarness(
  checkpoint: ManualHealthKitCheckpoint | null = null,
  loadCheckpoint?: HealthKitManualSyncDependencies["loadCheckpoint"],
) {
  let saved = checkpoint;
  let expired: ((taskId: string) => void) | undefined;
  let appStateListener: ((state: string) => void) | undefined;
  let foreground = true;
  const runSync = vi.fn<HealthKitManualSyncDependencies["runSync"]>();
  const starts: string[] = [];
  const persistCheckpoint = async (value: ManualHealthKitCheckpoint) => {
    if (saved && saved.requestId !== value.requestId) throw new Error("pending request");
    saved = value;
  };
  const deps: HealthKitManualSyncDependencies = {
    loadCheckpoint: vi.fn(loadCheckpoint ?? (async () => saved)),
    saveCheckpoint: vi.fn(persistCheckpoint),
    clearCheckpoint: vi.fn(async (_userId, requestId) => {
      if (saved?.requestId === requestId) saved = null;
    }),
    purgeCheckpoint: vi.fn(async () => {
      saved = null;
    }),
    startNative: vi.fn(async (taskId) => {
      starts.push(taskId);
      return { supported: true };
    }),
    completeNative: vi.fn(),
    listenForExpiration: vi.fn((listener) => {
      expired = listener;
      return { remove: vi.fn() };
    }),
    listenForAppState: vi.fn((listener) => {
      appStateListener = listener;
      return { remove: vi.fn() };
    }),
    isForeground: () => foreground,
    waitUntilForegroundConnected: vi.fn(async () => undefined),
    runSync,
    recordOutcome: vi.fn(async () => undefined),
    updateProgress: vi.fn(),
    createId: (() => {
      let id = 0;
      return () => `id-${++id}`;
    })(),
  };
  return {
    controller: new HealthKitManualSyncController({
      userId: "user-1",
      trpcClient: unusedTestClient,
      deps,
    }),
    deps,
    persistCheckpoint,
    expire(taskId: string) {
      expired?.(taskId);
    },
    appState(state: "active" | "background") {
      foreground = state === "active";
      appStateListener?.(state);
    },
    saved: () => saved,
    starts,
  };
}

const success = { deleted: 0, inserted: 2, errors: [] };
const checkpointStorageKey = "dofek_manual_health_kit_checkpoint_v1.user-1";

describe("HealthKitManualSyncController", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockDefaultRunSync.mockReset();
    mockCaptureException.mockReset();
    await SecureStore.deleteItemAsync(checkpointStorageKey);
  });

  it("routes a failed default connectivity probe through controller error reporting and cleans up", async () => {
    const stateListeners: Array<(state: string) => void> = [];
    const stateRemove = vi.fn();
    const networkRemove = vi.fn();
    const connectivityError = new Error("Connectivity probe failed");
    vi.mocked(AppState.addEventListener).mockImplementation((_event, listener) => {
      stateListeners.push(listener);
      return { remove: stateRemove };
    });
    vi.mocked(Network.addNetworkStateListener).mockReturnValue({ remove: networkRemove });
    vi.mocked(Network.getNetworkStateAsync).mockRejectedValue(connectivityError);
    mockDefaultRunSync.mockImplementation(
      async (input: Parameters<HealthKitManualSyncDependencies["runSync"]>[0]) => {
        input.onStage?.({ operation: "pushQuantitySamples" });
        for (const listener of stateListeners) listener("background");
        throw new Error("fetch failed: The network connection was lost.");
      },
    );
    const controller = new HealthKitManualSyncController({
      userId: "user-1",
      trpcClient: unusedTestClient,
    });

    await expect(controller.start(7)).rejects.toThrow("Connectivity probe failed");

    expect(controller.getSnapshot()).toMatchObject({
      status: "error",
      error: "Connectivity probe failed",
    });
    expect(stateRemove).toHaveBeenCalled();
    expect(networkRemove).toHaveBeenCalledOnce();
    expect(mockCaptureException).toHaveBeenCalledWith(connectivityError, {
      source: "health-kit-manual-connectivity",
    });
  }, 1000);

  it("does not let a late connected probe resume work after retirement", async () => {
    const stateListeners: Array<(state: string) => void> = [];
    const stateRemove = vi.fn();
    const networkRemove = vi.fn();
    const networkCheck = Promise.withResolvers<{
      isConnected: boolean;
      isInternetReachable: boolean;
    }>();
    vi.mocked(AppState.addEventListener).mockImplementation((_event, listener) => {
      stateListeners.push(listener);
      return { remove: stateRemove };
    });
    vi.mocked(Network.addNetworkStateListener).mockReturnValue({ remove: networkRemove });
    vi.mocked(Network.getNetworkStateAsync).mockReturnValue(networkCheck.promise);
    mockDefaultRunSync.mockImplementation(
      async (input: Parameters<HealthKitManualSyncDependencies["runSync"]>[0]) => {
        input.onStage?.({ operation: "pushQuantitySamples" });
        for (const listener of stateListeners) listener("background");
        throw new Error("fetch failed: The network connection was lost.");
      },
    );
    const controller = new HealthKitManualSyncController({
      userId: "user-1",
      trpcClient: unusedTestClient,
    });
    const started = controller.start(7);
    await vi.waitFor(() => expect(Network.getNetworkStateAsync).toHaveBeenCalledOnce());

    const retirement = controller.retire();
    networkCheck.resolve({ isConnected: true, isInternetReachable: true });
    await retirement;
    await expect(started).rejects.toThrow();
    expect(mockDefaultRunSync).toHaveBeenCalledOnce();
    expect(stateRemove).toHaveBeenCalledTimes(2);
    expect(networkRemove).toHaveBeenCalledOnce();
  });

  it("recovers an unknown stored cursor by purging only after an explicit new-window tap", async () => {
    await SecureStore.setItemAsync(
      checkpointStorageKey,
      JSON.stringify({
        requestId: "invalid-request",
        userId: "user-1",
        startDate: "2026-11-01T00:00:00.000Z",
        endDate: "2026-11-02T00:00:00.000Z",
        nextStage: "unknown-stage",
        requiresResume: true,
      }),
    );
    mockDefaultRunSync.mockResolvedValue(success);
    const controller = new HealthKitManualSyncController({
      userId: "user-1",
      trpcClient: unusedTestClient,
    });

    await controller.ready;
    expect(controller.getSnapshot()).toMatchObject({
      status: "error",
      error: expect.stringContaining("checkpoint"),
    });
    expect(await SecureStore.getItemAsync(checkpointStorageKey)).not.toBeNull();
    await expect(controller.resume()).rejects.toThrow(/invalid/i);
    expect(await SecureStore.getItemAsync(checkpointStorageKey)).not.toBeNull();

    await controller.start(7);

    expect(await SecureStore.getItemAsync(checkpointStorageKey)).toBeNull();
    expect(mockDefaultRunSync).toHaveBeenCalledOnce();
  });

  it("retries a transient default checkpoint read without purging stored data", async () => {
    await SecureStore.setItemAsync(
      checkpointStorageKey,
      JSON.stringify({
        requestId: "durable-request",
        userId: "user-1",
        startDate: "2026-11-01T00:00:00.000Z",
        endDate: "2026-11-02T00:00:00.000Z",
        nextStage: "sleep",
        requiresResume: true,
      }),
    );
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(
      new Error("Keychain temporarily unavailable"),
    );
    mockDefaultRunSync.mockResolvedValue(success);
    const controller = new HealthKitManualSyncController({
      userId: "user-1",
      trpcClient: unusedTestClient,
    });

    await controller.ready;
    expect(controller.getSnapshot().status).toBe("error");
    await controller.resume();

    expect(await SecureStore.getItemAsync(checkpointStorageKey)).toBeNull();
    expect(mockDefaultRunSync.mock.calls[0]?.[0]).toMatchObject({
      manualExecution: { startDate: "2026-11-01T00:00:00.000Z" },
    });
  });

  it("waits for the native grant before starting HealthKit work", async () => {
    const harness = makeHarness();
    const grant = Promise.withResolvers<{ supported: boolean }>();
    vi.mocked(harness.deps.startNative).mockReturnValue(grant.promise);
    harness.deps.runSync.mockResolvedValue(success);

    const started = harness.controller.start(7);
    await vi.waitFor(() => expect(harness.deps.startNative).toHaveBeenCalledTimes(1));
    expect(harness.deps.runSync).not.toHaveBeenCalled();
    grant.resolve({ supported: true });
    await expect(started).resolves.toEqual(success);
  });

  it("rejects a duplicate start while one manual operation owns the request", async () => {
    const harness = makeHarness();
    const attempt = Promise.withResolvers<typeof success>();
    harness.deps.runSync.mockReturnValue(attempt.promise);
    const started = harness.controller.start(7);
    await vi.waitFor(() => expect(harness.deps.runSync).toHaveBeenCalledTimes(1));

    await expect(harness.controller.start(7)).rejects.toThrow(/already running/i);
    attempt.resolve(success);
    await expect(started).resolves.toEqual(success);
  });

  it("releases observer ownership when manual work pauses", async () => {
    const harness = makeHarness();
    const attempt = Promise.withResolvers<typeof success>();
    harness.deps.runSync.mockReturnValue(attempt.promise);
    const started = harness.controller.start(7);
    await vi.waitFor(() => expect(harness.deps.runSync).toHaveBeenCalledTimes(1));
    harness.expire(harness.starts[0] ?? "");
    attempt.reject(new Error("stopped"));
    await expect(started).rejects.toThrow();

    await expect(harness.controller.runObserverAttempt(async () => "observer")).resolves.toBe(
      "observer",
    );
    expect(harness.controller.getSnapshot().status).toBe("paused");
  });

  it("restores the saved window as paused and submits a fresh native task on resume", async () => {
    const saved: ManualHealthKitCheckpoint = {
      requestId: "durable-request",
      userId: "user-1",
      startDate: "2026-11-01T00:00:00.000Z",
      endDate: "2026-11-02T00:00:00.000Z",
      nextStage: "sleep",
      requiresResume: false,
    };
    const harness = makeHarness(saved);
    harness.deps.runSync.mockResolvedValue(success);
    await harness.controller.ready;

    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "paused",
      completedStageCount: expect.any(Number),
      totalStageCount: expect.any(Number),
    });
    expect(harness.controller.getSnapshot().completedStageCount).toBeGreaterThan(0);
    expect(harness.controller.getSnapshot().totalStageCount).toBe(32);
    await harness.controller.resume();
    expect(harness.starts).toEqual(["id-1"]);
    expect(harness.deps.runSync.mock.calls[0]?.[0].manualExecution?.startDate).toBe(
      saved.startDate,
    );
  });

  it("publishes checkpoint restore failures and lets an explicit new window replace invalid state", async () => {
    const restoreError = new InvalidManualHealthKitCheckpointError();
    const harness = makeHarness(null, vi.fn().mockRejectedValueOnce(restoreError));
    harness.deps.runSync.mockResolvedValue(success);

    await harness.controller.ready;
    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "error",
      error: expect.stringContaining("checkpoint"),
    });
    expect(mockCaptureException).toHaveBeenCalledWith(restoreError, {
      source: "health-kit-manual-sync-restore",
      userId: "user-1",
    });

    await harness.controller.start(7);
    expect(harness.deps.purgeCheckpoint).toHaveBeenCalledWith("user-1");
    expect(harness.starts).toHaveLength(1);
  });

  it("retries a transient initial checkpoint read on explicit start and preserves valid saved work", async () => {
    const saved: ManualHealthKitCheckpoint = {
      requestId: "durable-request",
      userId: "user-1",
      startDate: "2026-11-01T00:00:00.000Z",
      endDate: "2026-11-02T00:00:00.000Z",
      nextStage: "sleep",
      requiresResume: true,
    };
    const loadCheckpoint = vi
      .fn<HealthKitManualSyncDependencies["loadCheckpoint"]>()
      .mockRejectedValueOnce(new Error("Keychain temporarily unavailable"))
      .mockResolvedValueOnce(saved);
    const harness = makeHarness(saved, loadCheckpoint);
    harness.deps.runSync.mockResolvedValue(success);

    await harness.controller.ready;
    expect(harness.controller.getSnapshot().status).toBe("error");
    await harness.controller.resume();

    expect(harness.deps.purgeCheckpoint).not.toHaveBeenCalled();
    expect(harness.deps.clearCheckpoint).toHaveBeenCalledWith("user-1", "durable-request");
    expect(harness.deps.runSync.mock.calls[0]?.[0].manualExecution?.startDate).toBe(
      saved.startDate,
    );
  });

  it("rejects concurrent new-window taps while checkpoint replacement is pending", async () => {
    const harness = makeHarness(
      null,
      vi.fn().mockRejectedValueOnce(new InvalidManualHealthKitCheckpointError()),
    );
    const purge = Promise.withResolvers<void>();
    vi.mocked(harness.deps.purgeCheckpoint).mockReturnValueOnce(purge.promise);
    harness.deps.runSync.mockResolvedValue(success);
    await harness.controller.ready;

    const first = harness.controller.start(7);
    await vi.waitFor(() => expect(harness.deps.purgeCheckpoint).toHaveBeenCalledOnce());
    await expect(harness.controller.start(30)).rejects.toThrow(/already running/i);
    purge.resolve();
    await first;
    expect(harness.deps.saveCheckpoint).toHaveBeenCalledOnce();
  });

  it("reports successful data work as a recording error and never replays it", async () => {
    const harness = makeHarness();
    harness.deps.runSync.mockResolvedValue(success);
    harness.deps.recordOutcome.mockRejectedValue(new Error("Sync history unavailable"));

    await expect(harness.controller.start(7)).rejects.toThrow("Sync history unavailable");

    expect(harness.deps.runSync).toHaveBeenCalledOnce();
    expect(harness.saved()).toBeNull();
    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "error",
      error: expect.stringContaining("history"),
    });
    expect(harness.deps.completeNative).toHaveBeenCalledWith("id-2", false);
  });

  it("settles native failure when terminal error recording also fails", async () => {
    const harness = makeHarness();
    harness.deps.runSync.mockRejectedValue(new Error("HealthKit upload failed"));
    harness.deps.recordOutcome.mockRejectedValue(new Error("Sync history unavailable"));

    await expect(harness.controller.start(7)).rejects.toThrow("HealthKit upload failed");

    expect(harness.deps.completeNative).toHaveBeenCalledWith("id-2", false);
    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "error",
      error: expect.stringContaining("Sync history unavailable"),
    });
  });

  it("reports a terminal error when the native task expires during outcome recording", async () => {
    const harness = makeHarness();
    const recording = Promise.withResolvers<void>();
    harness.deps.runSync.mockResolvedValue(success);
    harness.deps.recordOutcome.mockReturnValueOnce(recording.promise);

    const started = harness.controller.start(7);
    await vi.waitFor(() => expect(harness.deps.recordOutcome).toHaveBeenCalledOnce());
    harness.expire(harness.starts[0] ?? "");
    recording.resolve();

    await expect(started).rejects.toThrow(/interrupted/i);
    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "error",
      error: expect.stringContaining("data was synced, but completion was interrupted"),
    });
    expect(harness.saved()).toBeNull();
    expect(harness.deps.runSync).toHaveBeenCalledOnce();
    expect(harness.deps.completeNative).toHaveBeenCalledWith(harness.starts[0], false);
    expect(harness.deps.completeNative).not.toHaveBeenCalledWith(harness.starts[0], true);
  });

  it("preserves the outcome-recording failure after native expiration", async () => {
    const harness = makeHarness();
    const recording = Promise.withResolvers<void>();
    harness.deps.runSync.mockResolvedValue(success);
    harness.deps.recordOutcome.mockReturnValueOnce(recording.promise);

    const started = harness.controller.start(7);
    await vi.waitFor(() => expect(harness.deps.recordOutcome).toHaveBeenCalledOnce());
    harness.expire(harness.starts[0] ?? "");
    recording.reject(new Error("Sync history unavailable"));

    await expect(started).rejects.toThrow("Sync history unavailable");
    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "error",
      error: expect.stringContaining("Sync history unavailable"),
    });
    expect(harness.saved()).toBeNull();
    expect(harness.deps.runSync).toHaveBeenCalledOnce();
    expect(harness.deps.completeNative).toHaveBeenCalledWith(harness.starts[0], false);
    expect(harness.deps.completeNative).not.toHaveBeenCalledWith(harness.starts[0], true);
  });

  it("does not publish success when the account retires during outcome recording", async () => {
    const harness = makeHarness();
    const recording = Promise.withResolvers<void>();
    harness.deps.runSync.mockResolvedValue(success);
    harness.deps.recordOutcome.mockReturnValueOnce(recording.promise);

    const started = harness.controller.start(7);
    await vi.waitFor(() => expect(harness.deps.recordOutcome).toHaveBeenCalledOnce());
    const retirement = harness.controller.retire();
    recording.resolve();

    await expect(started).rejects.toThrow(/no longer available/i);
    await retirement;
    expect(harness.controller.getSnapshot()).toMatchObject({ status: "idle" });
    expect(harness.saved()).toBeNull();
    expect(harness.deps.runSync).toHaveBeenCalledOnce();
    expect(harness.deps.completeNative).toHaveBeenCalledWith(harness.starts[0], false);
    expect(harness.deps.completeNative).not.toHaveBeenCalledWith(harness.starts[0], true);
  });

  it("does not publish a terminal error after retirement during error recording", async () => {
    const harness = makeHarness();
    const recording = Promise.withResolvers<void>();
    harness.deps.runSync.mockRejectedValue(new Error("HealthKit upload failed"));
    harness.deps.recordOutcome.mockReturnValueOnce(recording.promise);

    const started = harness.controller.start(7);
    await vi.waitFor(() => expect(harness.deps.recordOutcome).toHaveBeenCalledOnce());
    const retirement = harness.controller.retire();
    recording.resolve();

    await expect(started).rejects.toThrow("HealthKit upload failed");
    await retirement;
    expect(harness.controller.getSnapshot()).toMatchObject({ status: "idle", error: null });
    expect(harness.saved()).toBeNull();
    expect(harness.deps.completeNative).toHaveBeenCalledWith(harness.starts[0], false);
    expect(harness.deps.completeNative).not.toHaveBeenCalledWith(harness.starts[0], true);
  });

  it("does not save a late checkpoint after account retirement", async () => {
    const harness = makeHarness();
    const checkpointWrite = Promise.withResolvers<void>();
    let writes = 0;
    vi.mocked(harness.deps.saveCheckpoint).mockImplementation(async () => {
      writes += 1;
      if (writes === 2) await checkpointWrite.promise;
    });
    harness.deps.runSync.mockImplementation(async ({ manualExecution }) => {
      await manualExecution?.onStageComplete({
        stage: "additive-and-category",
        completedStageCount: 1,
        totalStageCount: 32,
      });
      return success;
    });
    const started = harness.controller.start(7);
    await vi.waitFor(() => expect(harness.deps.saveCheckpoint).toHaveBeenCalledTimes(2));
    const retirement = harness.controller.retire();
    checkpointWrite.resolve();
    await retirement;
    await expect(started).rejects.toThrow();
    expect(harness.deps.clearCheckpoint).toHaveBeenCalledWith("user-1", "id-1");
    expect(harness.saved()).toBeNull();
  });

  it("retries strict checkpoint purge after controller resources were already disposed", async () => {
    const harness = makeHarness({
      requestId: "durable-request",
      userId: "user-1",
      startDate: "2026-11-01T00:00:00.000Z",
      endDate: "2026-11-02T00:00:00.000Z",
      nextStage: "sleep",
      requiresResume: true,
    });
    vi.mocked(harness.deps.purgeCheckpoint)
      .mockRejectedValueOnce(new Error("Keychain is locked"))
      .mockResolvedValueOnce(undefined);

    await harness.controller.ready;
    harness.controller.dispose();
    await expect(harness.controller.retire()).rejects.toThrow("Keychain is locked");
    expect(harness.deps.clearCheckpoint).toHaveBeenCalledWith("user-1", "durable-request");
    await harness.controller.retire();

    expect(harness.deps.purgeCheckpoint).toHaveBeenCalledTimes(2);
    expect(harness.saved()).toBeNull();
  });

  it("requires a fresh Resume tap and native task id after expiration", async () => {
    const harness = makeHarness();
    const attempt = Promise.withResolvers<typeof success>();
    harness.deps.runSync.mockReturnValueOnce(attempt.promise).mockResolvedValueOnce(success);
    const started = harness.controller.start(7);
    await vi.waitFor(() => expect(harness.deps.runSync).toHaveBeenCalledTimes(1));
    harness.expire(harness.starts[0] ?? "");
    attempt.reject(new Error("native expiration"));
    await expect(started).rejects.toThrow();

    expect(harness.starts).toHaveLength(1);
    await harness.controller.resume();
    expect(harness.starts).toHaveLength(2);
    expect(harness.starts[1]).not.toBe(harness.starts[0]);
  });

  it("rejects Resume while another manual attempt owns the request", async () => {
    const harness = makeHarness();
    const activeAttempt = Promise.withResolvers<typeof success>();
    harness.deps.runSync.mockReturnValueOnce(activeAttempt.promise).mockResolvedValue(success);
    const started = harness.controller.start(7);
    await vi.waitFor(() => expect(harness.deps.runSync).toHaveBeenCalledOnce());
    const duplicateResume = harness.controller.resume().then(
      () => "fulfilled",
      () => "rejected",
    );
    activeAttempt.resolve(success);

    const [startResult, duplicateResult] = await Promise.allSettled([started, duplicateResume]);
    expect(startResult.status).toBe("fulfilled");
    expect(duplicateResult).toMatchObject({ status: "fulfilled", value: "rejected" });
    expect(harness.deps.startNative).toHaveBeenCalledOnce();
  });

  it("keeps the replacement admission reserved when the expired start settles", async () => {
    const harness = makeHarness();
    const expiredAttempt = Promise.withResolvers<typeof success>();
    harness.deps.runSync.mockReturnValueOnce(expiredAttempt.promise).mockResolvedValue(success);
    const clearing = Promise.withResolvers<void>();
    const clearCheckpoint = harness.deps.clearCheckpoint;
    vi.mocked(harness.deps.clearCheckpoint).mockImplementationOnce(async (...args) => {
      await clearing.promise;
      await clearCheckpoint(...args);
    });
    const first = harness.controller.start(7);
    await vi.waitFor(() => expect(harness.deps.runSync).toHaveBeenCalledOnce());
    harness.expire(harness.starts[0] ?? "");
    const replacement = harness.controller.start(30);
    const firstSettled = first.then(
      () => undefined,
      () => undefined,
    );

    try {
      expiredAttempt.resolve(success);
      await firstSettled;
      await vi.waitFor(() => expect(harness.deps.clearCheckpoint).toHaveBeenCalledOnce());
      await expect(harness.controller.resume()).rejects.toThrow(/already running/i);
      expect(harness.deps.startNative).toHaveBeenCalledOnce();
      clearing.resolve();
      await expect(replacement).resolves.toEqual(success);
      expect(harness.deps.startNative).toHaveBeenCalledTimes(2);
    } finally {
      clearing.resolve();
      expiredAttempt.resolve(success);
      await Promise.allSettled([first, replacement]);
    }
  });

  it("settles an expired in-flight query before a Resume tap starts its new native task", async () => {
    const harness = makeHarness();
    const expiredQuery = Promise.withResolvers<typeof success>();
    const resumedQuery = Promise.withResolvers<typeof success>();
    harness.deps.runSync
      .mockReturnValueOnce(expiredQuery.promise)
      .mockReturnValueOnce(resumedQuery.promise);
    const first = harness.controller.start(7);
    void first.catch(() => undefined);
    await vi.waitFor(() => expect(harness.deps.runSync).toHaveBeenCalledTimes(1));
    harness.expire(harness.starts[0] ?? "");
    const resumed = harness.controller.resume();

    try {
      expect(harness.starts).toHaveLength(1);
      expiredQuery.resolve(success);
      await vi.waitFor(() => expect(harness.deps.runSync).toHaveBeenCalledTimes(2));
      expect(harness.controller.getSnapshot().status).toBe("running");
      expect(harness.deps.completeNative).not.toHaveBeenCalledWith(harness.starts[1], true);
    } finally {
      expiredQuery.resolve(success);
      resumedQuery.resolve(success);
      await Promise.allSettled([first, resumed]);
    }
  });

  it("replaces a foreground-recovery wait before admitting the resumed attempt", async () => {
    const harness = makeHarness();
    const firstUpload = Promise.withResolvers<typeof success>();
    const resumedQuery = Promise.withResolvers<typeof success>();
    let recoverySignal: AbortSignal | undefined;
    vi.mocked(harness.deps.waitUntilForegroundConnected).mockImplementationOnce(
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          recoverySignal = signal;
          signal.addEventListener("abort", () => reject(new Error("recovery wait aborted")), {
            once: true,
          });
        }),
    );
    harness.deps.runSync
      .mockImplementationOnce(async (input) => {
        input.onStage?.({ operation: "pushQuantitySamples" });
        return firstUpload.promise;
      })
      .mockReturnValueOnce(resumedQuery.promise);
    const first = harness.controller.start(7);
    void first.catch(() => undefined);
    await vi.waitFor(() => expect(harness.deps.runSync).toHaveBeenCalledTimes(1));
    harness.appState("background");
    firstUpload.reject(new Error("fetch failed: The network connection was lost."));
    await vi.waitFor(() => expect(recoverySignal).toBeDefined());
    const resumed = harness.controller.resume();
    void resumed.catch(() => undefined);

    try {
      await vi.waitFor(() => expect(harness.deps.runSync).toHaveBeenCalledTimes(2));
      expect(recoverySignal?.aborted).toBe(true);
      expect(harness.starts).toHaveLength(2);
      expect(harness.controller.getSnapshot().status).toBe("running");
    } finally {
      firstUpload.resolve(success);
      resumedQuery.resolve(success);
      await harness.controller.retire();
      await Promise.allSettled([first, resumed]);
    }
  });

  it("does not admit a replacement range after retirement while an expired query settles", async () => {
    const harness = makeHarness();
    const expiredQuery = Promise.withResolvers<typeof success>();
    harness.deps.runSync.mockReturnValueOnce(expiredQuery.promise);
    const first = harness.controller.start(7);
    void first.catch(() => undefined);
    await vi.waitFor(() => expect(harness.deps.runSync).toHaveBeenCalledOnce());
    harness.expire(harness.starts[0] ?? "");
    const replacement = harness.controller.start(30);
    void replacement.catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();

    const retirement = harness.controller.retire();
    await retirement;
    expiredQuery.resolve(success);
    await Promise.allSettled([first, replacement]);

    expect(harness.starts).toEqual(["id-2"]);
    expect(harness.deps.runSync).toHaveBeenCalledOnce();
    expect(harness.deps.saveCheckpoint).toHaveBeenCalledOnce();
    expect(harness.saved()).toBeNull();
  });

  it("does not write a replacement checkpoint when retirement wins a clear wait", async () => {
    const saved: ManualHealthKitCheckpoint = {
      requestId: "durable-request",
      userId: "user-1",
      startDate: "2026-11-01T00:00:00.000Z",
      endDate: "2026-11-02T00:00:00.000Z",
      nextStage: "sleep",
      requiresResume: true,
    };
    const harness = makeHarness(saved);
    const checkpointClear = Promise.withResolvers<void>();
    vi.mocked(harness.deps.clearCheckpoint).mockImplementationOnce(async () => {
      await checkpointClear.promise;
    });
    await harness.controller.ready;
    const replacement = harness.controller.start(30);
    void replacement.catch(() => undefined);
    await vi.waitFor(() => expect(harness.deps.clearCheckpoint).toHaveBeenCalledOnce());

    await harness.controller.retire();
    checkpointClear.resolve();
    await Promise.allSettled([replacement]);

    expect(harness.deps.saveCheckpoint).not.toHaveBeenCalled();
    expect(harness.starts).toHaveLength(0);
    expect(harness.saved()).toBeNull();
  });

  it("does not start native work when retirement wins a replacement checkpoint save", async () => {
    const harness = makeHarness();
    const checkpointSave = Promise.withResolvers<void>();
    let saves = 0;
    vi.mocked(harness.deps.saveCheckpoint).mockImplementation(async (checkpoint) => {
      saves += 1;
      const write = harness.persistCheckpoint(checkpoint);
      if (saves === 3) await checkpointSave.promise;
      await write;
    });
    const expiredQuery = Promise.withResolvers<typeof success>();
    harness.deps.runSync.mockReturnValueOnce(expiredQuery.promise);
    const first = harness.controller.start(7);
    void first.catch(() => undefined);
    await vi.waitFor(() => expect(harness.deps.runSync).toHaveBeenCalledOnce());
    harness.expire(harness.starts[0] ?? "");
    const replacement = harness.controller.start(30);
    void replacement.catch(() => undefined);
    expiredQuery.resolve(success);
    await vi.waitFor(() => expect(saves).toBe(3));

    const retirement = harness.controller.retire();
    checkpointSave.resolve();
    await retirement;
    await Promise.allSettled([first, replacement]);

    expect(harness.starts).toEqual(["id-2"]);
  });

  it("keeps storage cursors semantic while reporting readable raw and clinical progress", async () => {
    const harness = makeHarness();
    const stages = [
      ["additive-and-category", 1, "Synced health metrics and categories"],
      ["raw:HKQuantityTypeIdentifierBodyMass", 11, "Synced body mass"],
      ["raw:HKQuantityTypeIdentifierWalkingSpeed", 12, "Synced walking speed"],
      ["clinical:HKClinicalTypeIdentifierAllergyRecord", 20, "Synced allergy records"],
      ["clinical:HKClinicalTypeIdentifierConditionRecord", 21, "Synced condition records"],
      ["clinical:HKClinicalTypeIdentifierMedicationRecord", 28, "Synced medication records"],
      ["workouts", 29, "Synced workouts"],
      ["sleep", 30, "Synced sleep"],
      ["running-steps", 31, "Synced running steps"],
    ] as const;
    harness.deps.runSync.mockImplementation(async ({ manualExecution }) => {
      for (const [stage, completedStageCount] of stages) {
        await manualExecution?.onStageComplete({
          stage,
          completedStageCount,
          totalStageCount: 32,
        });
      }
      return success;
    });

    await harness.controller.start(7);

    expect(harness.deps.updateProgress.mock.calls).toEqual(
      stages.map(([, completedStageCount, message]) => ["id-2", completedStageCount, 32, message]),
    );
    expect(harness.saved()).toBeNull();
  });

  it("retries one known transport failure after foreground and connectivity return, without holding the gate", async () => {
    const harness = makeHarness();
    const foreground = Promise.withResolvers<void>();
    const firstAttempt = Promise.withResolvers<typeof success>();
    vi.mocked(harness.deps.waitUntilForegroundConnected).mockReturnValue(foreground.promise);
    harness.deps.runSync
      .mockImplementationOnce(async (input) => {
        input.onStage?.({ operation: "pushQuantitySamples" });
        return firstAttempt.promise;
      })
      .mockResolvedValueOnce(success);
    const started = harness.controller.start(7);
    await vi.waitFor(() => expect(harness.deps.runSync).toHaveBeenCalledTimes(1));
    harness.appState("background");
    firstAttempt.reject(new Error("fetch failed: The network connection was lost."));
    // Another observer can use the gate while recovery waits for active and connected state.
    await vi.waitFor(() =>
      expect(harness.deps.waitUntilForegroundConnected).toHaveBeenCalledTimes(1),
    );
    await expect(harness.controller.runObserverAttempt(async () => "observer")).resolves.toBe(
      "observer",
    );
    harness.appState("active");
    foreground.resolve();
    await expect(started).resolves.toEqual(success);
    expect(harness.deps.runSync).toHaveBeenCalledTimes(2);
  });

  it("surfaces a failed fresh attempt after one background recovery retry", async () => {
    const harness = makeHarness();
    const foreground = Promise.withResolvers<void>();
    vi.mocked(harness.deps.waitUntilForegroundConnected).mockReturnValue(foreground.promise);
    const firstAttempt = Promise.withResolvers<typeof success>();
    harness.deps.runSync
      .mockImplementationOnce(async (input) => {
        input.onStage?.({ operation: "pushQuantitySamples" });
        return firstAttempt.promise;
      })
      .mockRejectedValueOnce(new Error("The server rejected the fresh attempt."));
    const started = harness.controller.start(7);
    await vi.waitFor(() => expect(harness.deps.runSync).toHaveBeenCalledTimes(1));
    harness.appState("background");
    firstAttempt.reject(new Error("fetch failed: The network connection was lost."));
    await vi.waitFor(() =>
      expect(harness.deps.waitUntilForegroundConnected).toHaveBeenCalledTimes(1),
    );
    harness.appState("active");
    foreground.resolve();
    await expect(started).rejects.toThrow("The server rejected the fresh attempt.");
    expect(harness.deps.runSync).toHaveBeenCalledTimes(2);
    expect(harness.controller.getSnapshot()).toMatchObject({
      status: "error",
      error: expect.any(String),
    });
  });

  it("does not retry a transient upload error that did not cross background", async () => {
    const harness = makeHarness();
    harness.deps.runSync.mockImplementation(async (input) => {
      input.onStage?.({ operation: "pushQuantitySamples" });
      throw new Error("fetch failed: The network connection was lost.");
    });

    await expect(harness.controller.start(7)).rejects.toThrow("network connection was lost");
    expect(harness.deps.runSync).toHaveBeenCalledTimes(1);
    expect(harness.deps.waitUntilForegroundConnected).not.toHaveBeenCalled();
  });

  it("pauses on the actual HealthKit locked-data error without recording a terminal error", async () => {
    const harness = makeHarness();
    const foreground = Promise.withResolvers<void>();
    vi.mocked(harness.deps.waitUntilForegroundConnected).mockReturnValue(foreground.promise);
    harness.deps.runSync
      .mockRejectedValueOnce({ code: "HEALTHKIT_DATABASE_INACCESSIBLE" })
      .mockResolvedValueOnce(success);
    const started = harness.controller.start(7);
    await vi.waitFor(() =>
      expect(harness.deps.waitUntilForegroundConnected).toHaveBeenCalledTimes(1),
    );
    expect(harness.deps.waitUntilForegroundConnected).toHaveBeenCalledWith(
      expect.any(AbortSignal),
      true,
    );
    expect(harness.starts).toHaveLength(1);
    harness.appState("active");
    foreground.resolve();
    await expect(started).resolves.toEqual(success);
    expect(harness.deps.waitUntilForegroundConnected).toHaveBeenCalledTimes(1);
    expect(harness.starts).toHaveLength(1);
    expect(harness.deps.recordOutcome).toHaveBeenCalledTimes(1);
  });

  it("pauses on backgrounding when native continued processing is unsupported", async () => {
    const harness = makeHarness();
    const foreground = Promise.withResolvers<void>();
    vi.mocked(harness.deps.waitUntilForegroundConnected).mockReturnValue(foreground.promise);
    vi.mocked(harness.deps.startNative).mockImplementation(async (taskId) => {
      harness.starts.push(taskId);
      return { supported: false };
    });
    let attempts = 0;
    harness.deps.runSync.mockImplementation(async ({ manualExecution }) => {
      attempts += 1;
      if (attempts === 1) {
        harness.appState("background");
        await manualExecution.assertCanContinue();
      }
      return success;
    });
    const started = harness.controller.start(7);
    await vi.waitFor(() =>
      expect(harness.deps.waitUntilForegroundConnected).toHaveBeenCalledTimes(1),
    );
    expect(harness.deps.waitUntilForegroundConnected).toHaveBeenCalledWith(
      expect.any(AbortSignal),
      true,
    );
    harness.appState("active");
    foreground.resolve();
    await expect(started).resolves.toEqual(success);
    expect(attempts).toBe(2);
    expect(harness.starts).toHaveLength(1);
  });
});
