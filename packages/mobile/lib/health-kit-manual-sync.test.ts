import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManualHealthKitCheckpoint } from "./health-kit-manual-checkpoint";
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
vi.mock("expo-network", () => ({
  addNetworkStateListener: vi.fn(() => ({ remove: vi.fn() })),
  getNetworkStateAsync: vi.fn(async () => ({ isConnected: true, isInternetReachable: true })),
}));
vi.mock("./apple-health-provider", () => ({ AppleHealthSyncService: class {} }));

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

function makeHarness(checkpoint: ManualHealthKitCheckpoint | null = null) {
  let saved = checkpoint;
  let expired: ((taskId: string) => void) | undefined;
  let appStateListener: ((state: string) => void) | undefined;
  let foreground = true;
  const runSync = vi.fn<HealthKitManualSyncDependencies["runSync"]>();
  const starts: string[] = [];
  const deps: HealthKitManualSyncDependencies = {
    loadCheckpoint: vi.fn(async () => saved),
    saveCheckpoint: vi.fn(async (value) => {
      if (saved && saved.requestId !== value.requestId) throw new Error("pending request");
      saved = value;
    }),
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

describe("HealthKitManualSyncController", () => {
  beforeEach(() => vi.clearAllMocks());

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
