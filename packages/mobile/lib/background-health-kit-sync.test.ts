import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSetupBackgroundObservers = vi.fn().mockResolvedValue(true);
const mockAddSampleUpdateListener = vi.fn().mockReturnValue({ remove: vi.fn() });
const mockCompleteObserverUpdates = vi.fn().mockReturnValue(0);
const mockSetObserverSyncInProgress = vi.fn();
const mockTeardownBackgroundObservers = vi.fn().mockReturnValue(0);
const mockHasEverAuthorized = vi.fn().mockReturnValue(true);
const mockIsAvailable = vi.fn().mockReturnValue(true);
const mockGetRequestStatus = vi.fn().mockResolvedValue("unnecessary");
const mockRequestPermissions = vi.fn().mockResolvedValue(true);
const mockQueryAnchoredSamples = vi.fn().mockResolvedValue({
  queryId: "query-1",
  samples: [],
  deletedUUIDs: [],
});
const mockCompleteAnchoredQuery = vi.fn().mockResolvedValue(true);
const mockCaptureException = vi.fn();
const mockLoggerInfo = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();
const mockLoadDeviceErasureCutoff = vi.fn().mockResolvedValue(null);

vi.mock("../modules/health-kit", () => ({
  isAvailable: (...args: unknown[]) => mockIsAvailable(...args),
  hasEverAuthorized: (...args: unknown[]) => mockHasEverAuthorized(...args),
  getRequestStatus: (...args: unknown[]) => mockGetRequestStatus(...args),
  requestPermissions: (...args: unknown[]) => mockRequestPermissions(...args),
  queryAnchoredSamples: (...args: unknown[]) => mockQueryAnchoredSamples(...args),
  completeAnchoredQuery: (...args: unknown[]) => mockCompleteAnchoredQuery(...args),
  setupBackgroundObservers: (...args: unknown[]) => mockSetupBackgroundObservers(...args),
  addSampleUpdateListener: (...args: unknown[]) => mockAddSampleUpdateListener(...args),
  completeObserverUpdates: (...args: unknown[]) => mockCompleteObserverUpdates(...args),
  setObserverSyncInProgress: (...args: unknown[]) => mockSetObserverSyncInProgress(...args),
  teardownBackgroundObservers: (...args: unknown[]) => mockTeardownBackgroundObservers(...args),
  queryDailyStatistics: vi.fn().mockResolvedValue([]),
  queryCategorySamples: vi.fn().mockResolvedValue([]),
  queryQuantitySamples: vi.fn().mockResolvedValue([]),
  queryWorkouts: vi.fn().mockResolvedValue([]),
  queryWorkoutRoutes: vi.fn().mockResolvedValue([]),
  querySleepSamples: vi.fn().mockResolvedValue([]),
}));

vi.mock("./telemetry", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

vi.mock("./device-erasure-cutoff", async (importOriginal) => {
  const original = await importOriginal<typeof import("./device-erasure-cutoff")>();
  return {
    ...original,
    loadDeviceErasureCutoff: (...args: unknown[]) => mockLoadDeviceErasureCutoff(...args),
  };
});

import {
  type HealthKitSample,
  queryDailyStatistics,
  queryWorkoutRoutes,
  queryWorkouts,
} from "../modules/health-kit";
import {
  initBackgroundHealthKitSync,
  teardownBackgroundHealthKitSync,
} from "./background-health-kit-sync";

function createMockClient() {
  return {
    healthKitSync: {
      pushQuantitySamples: {
        mutate: vi.fn().mockResolvedValue({ inserted: 0, errors: [] }),
      },
      deleteQuantitySamples: {
        mutate: vi.fn().mockResolvedValue({ deleted: 0 }),
      },
      pushWorkouts: {
        mutate: vi.fn().mockResolvedValue({ inserted: 0 }),
      },
      pushWorkoutRoutes: {
        mutate: vi.fn().mockResolvedValue({ inserted: 0 }),
      },
      pushSleepSamples: {
        mutate: vi.fn().mockResolvedValue({ inserted: 0 }),
      },
    },
  };
}

function createDeferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  if (!resolve) {
    throw new Error("deferred resolver was not initialized");
  }
  return { promise, resolve };
}

describe("initBackgroundHealthKitSync", () => {
  beforeEach(() => {
    teardownBackgroundHealthKitSync();
    vi.clearAllMocks();
    mockLoadDeviceErasureCutoff.mockResolvedValue(null);
  });

  afterEach(() => {
    teardownBackgroundHealthKitSync();
  });

  it("sets up native observer queries", async () => {
    const client = createMockClient();
    await initBackgroundHealthKitSync(client);

    expect(mockSetupBackgroundObservers).toHaveBeenCalledTimes(1);
  });

  it("registers a sample update listener", async () => {
    const client = createMockClient();
    await initBackgroundHealthKitSync(client);

    expect(mockAddSampleUpdateListener).toHaveBeenCalledTimes(1);
    expect(typeof mockAddSampleUpdateListener.mock.calls[0][0]).toBe("function");
  });

  it("registers the sample listener before starting native observers", async () => {
    const client = createMockClient();
    await initBackgroundHealthKitSync(client);

    expect(mockAddSampleUpdateListener.mock.invocationCallOrder[0]).toBeLessThan(
      mockSetupBackgroundObservers.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("runs an immediate catch-up sync when initialized", async () => {
    const client = createMockClient();
    await initBackgroundHealthKitSync(client);

    await vi.waitFor(() => {
      expect(client.healthKitSync.pushWorkouts.mutate).toHaveBeenCalledTimes(1);
    });
  });

  it("logs monotonic structured stage duration and context", async () => {
    vi.useFakeTimers();
    const firstStage = createDeferred<[]>();
    vi.mocked(queryDailyStatistics).mockReturnValueOnce(firstStage.promise);
    const wallClock = vi.spyOn(Date, "now");

    try {
      await initBackgroundHealthKitSync(createMockClient());

      expect(mockLoggerInfo).toHaveBeenCalledWith("bg-healthkit-sync", "Sync stage started", {
        operation: "queryDailyStatistics",
        typeIdentifier: "HKQuantityTypeIdentifierStepCount",
      });

      wallClock.mockReturnValue(0);
      await vi.advanceTimersByTimeAsync(250);
      firstStage.resolve([]);
      await vi.waitFor(() => {
        expect(mockLoggerInfo).toHaveBeenCalledWith(
          "bg-healthkit-sync",
          "Sync stage completed",
          expect.objectContaining({
            operation: "queryDailyStatistics",
            typeIdentifier: "HKQuantityTypeIdentifierStepCount",
            outcome: "completed",
          }),
        );
      });
      const completion = mockLoggerInfo.mock.calls.find(
        ([, message, data]) =>
          message === "Sync stage completed" &&
          data?.typeIdentifier === "HKQuantityTypeIdentifierStepCount",
      );
      expect(completion?.[2]?.durationMs).toBeGreaterThanOrEqual(250);
    } finally {
      wallClock.mockRestore();
      vi.useRealTimers();
    }
  });

  it("sets up sync even when the legacy authorization flag is false", async () => {
    mockHasEverAuthorized.mockReturnValueOnce(false);
    const client = createMockClient();
    await initBackgroundHealthKitSync(client);

    expect(mockSetupBackgroundObservers).toHaveBeenCalledTimes(1);
    expect(mockAddSampleUpdateListener).toHaveBeenCalledTimes(1);
  });

  it("proceeds with sync when previously authorized even if new types need permission", async () => {
    mockHasEverAuthorized.mockReturnValue(true);
    const client = createMockClient();
    await initBackgroundHealthKitSync(client);

    expect(mockSetupBackgroundObservers).toHaveBeenCalledTimes(1);
    expect(mockAddSampleUpdateListener).toHaveBeenCalledTimes(1);
  });

  it("calls onSyncComplete after successful sync", async () => {
    vi.useFakeTimers();
    const client = createMockClient();
    const onSyncComplete = vi.fn();
    await initBackgroundHealthKitSync(client, onSyncComplete);

    // Trigger the listener callback
    const listener = mockAddSampleUpdateListener.mock.calls[0][0];
    listener({
      typeIdentifier: "HKQuantityTypeIdentifierStepCount",
      updateId: "update-1",
    });

    // Allow the serialized observer sync to settle.
    await vi.advanceTimersByTimeAsync(5000);
    // Let sync promises resolve
    await vi.runAllTimersAsync();

    expect(onSyncComplete).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does not call onSyncComplete on sync failure", async () => {
    vi.useFakeTimers();
    const client = createMockClient();
    const onSyncComplete = vi.fn();
    await initBackgroundHealthKitSync(client, onSyncComplete);
    await vi.runAllTimersAsync();
    onSyncComplete.mockClear();
    vi.mocked(queryDailyStatistics).mockResolvedValueOnce([{ date: "2026-03-22", value: 1_000 }]);
    client.healthKitSync.pushQuantitySamples.mutate.mockRejectedValueOnce(new Error("network"));

    const listener = mockAddSampleUpdateListener.mock.calls[0][0];
    listener({
      typeIdentifier: "HKQuantityTypeIdentifierStepCount",
      updateId: "update-1",
    });

    await vi.advanceTimersByTimeAsync(5000);
    await vi.runAllTimersAsync();

    expect(onSyncComplete).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("reports asynchronous completion callback failures to Sentry", async () => {
    const client = createMockClient();
    const invalidationError = new Error("cache invalidation failed");

    await initBackgroundHealthKitSync(client, () => Promise.reject(invalidationError));

    await vi.waitFor(() => {
      expect(mockCaptureException).toHaveBeenCalledWith(invalidationError, {
        source: "bg-healthkit-sync",
      });
    });
  });

  it("reports sync failures to Sentry", async () => {
    vi.useFakeTimers();
    const client = createMockClient();
    await initBackgroundHealthKitSync(client);
    await vi.runAllTimersAsync();
    mockCaptureException.mockClear();
    vi.mocked(queryWorkouts).mockResolvedValueOnce([
      {
        uuid: "workout-1",
        activityType: 1,
        startDate: "2026-03-22T10:00:00Z",
        endDate: "2026-03-22T11:00:00Z",
        duration: 3600,
        totalDistance: 10000,
        sourceName: "Apple Watch",
      },
    ]);
    const networkError = new Error("network timeout");
    client.healthKitSync.pushWorkouts.mutate.mockRejectedValueOnce(networkError);

    const listener = mockAddSampleUpdateListener.mock.calls[0][0];
    listener({
      typeIdentifier: "HKWorkoutTypeIdentifier",
      updateId: "update-1",
    });

    await vi.advanceTimersByTimeAsync(5000);
    await vi.runAllTimersAsync();

    expect(mockCaptureException).toHaveBeenCalledWith(networkError, {
      source: "bg-healthkit-sync",
    });
    vi.useRealTimers();
  });

  it("does not report locked-device errors to Sentry", async () => {
    vi.useFakeTimers();
    const client = createMockClient();
    await initBackgroundHealthKitSync(client);
    await vi.runAllTimersAsync();
    await vi.waitFor(() => {
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        "bg-healthkit-sync",
        expect.stringContaining("Sync complete:"),
        expect.objectContaining({
          errorCount: 0,
          inserted: 0,
        }),
      );
    });
    mockCaptureException.mockClear();
    mockCompleteObserverUpdates.mockClear();
    vi.mocked(queryWorkouts).mockRejectedValueOnce(
      Object.assign(new Error("HealthKit data is unavailable while the device is locked"), {
        code: "HEALTHKIT_DATABASE_INACCESSIBLE",
      }),
    );

    const listener = mockAddSampleUpdateListener.mock.calls[0][0];
    listener({
      typeIdentifier: "HKWorkoutTypeIdentifier",
      updateId: "update-1",
    });

    await vi.advanceTimersByTimeAsync(5000);
    await vi.runAllTimersAsync();

    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "bg-healthkit-sync",
      "Device locked, skipping sync",
    );
    expect(mockCompleteObserverUpdates).toHaveBeenCalledWith(["update-1"], false);
    vi.useRealTimers();
  });

  it("does not report background fetch timeouts to Sentry (DOFEK-MOBILE-19)", async () => {
    vi.useFakeTimers();
    const client = createMockClient();
    await initBackgroundHealthKitSync(client);
    await vi.runAllTimersAsync();
    mockCaptureException.mockClear();
    vi.mocked(queryDailyStatistics).mockResolvedValueOnce([{ date: "2026-03-22", value: 1_000 }]);
    client.healthKitSync.pushQuantitySamples.mutate.mockRejectedValueOnce(
      new Error("fetch failed: UnexpectedException: The request timed out."),
    );

    const listener = mockAddSampleUpdateListener.mock.calls[0][0];
    listener({
      typeIdentifier: "HKQuantityTypeIdentifierStepCount",
      updateId: "update-1",
    });

    await vi.advanceTimersByTimeAsync(5000);
    await vi.runAllTimersAsync();

    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "bg-healthkit-sync",
      "Background HealthKit upload timed out; retrying on next delivery",
    );
    expect(mockCompleteObserverUpdates).toHaveBeenCalledWith(["update-1"], false);
    vi.useRealTimers();
  });

  it("does not report TRPCClientError background fetch timeouts to Sentry (DOFEK-MOBILE-19)", async () => {
    vi.useFakeTimers();
    const client = createMockClient();
    await initBackgroundHealthKitSync(client);
    await vi.runAllTimersAsync();
    mockCaptureException.mockClear();
    vi.mocked(queryDailyStatistics).mockResolvedValueOnce([{ date: "2026-03-22", value: 1_000 }]);
    const timeoutError = new Error("fetch failed: UnexpectedException: The request timed out.");
    client.healthKitSync.pushQuantitySamples.mutate.mockRejectedValueOnce(
      new Error("TRPCClientError", { cause: timeoutError }),
    );

    const listener = mockAddSampleUpdateListener.mock.calls[0][0];
    listener({
      typeIdentifier: "HKQuantityTypeIdentifierStepCount",
      updateId: "update-1",
    });

    await vi.advanceTimersByTimeAsync(5000);
    await vi.runAllTimersAsync();

    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "bg-healthkit-sync",
      "Background HealthKit upload timed out; retrying on next delivery",
    );
    expect(mockCompleteObserverUpdates).toHaveBeenCalledWith(["update-1"], false);
    vi.useRealTimers();
  });

  it("does not report observer sync result errors that are only transient timeouts", async () => {
    vi.useFakeTimers();
    const client = createMockClient();
    await initBackgroundHealthKitSync(client);
    await vi.runAllTimersAsync();
    mockCaptureException.mockClear();
    vi.mocked(queryWorkouts).mockResolvedValueOnce([
      {
        uuid: "workout-1",
        activityType: 1,
        startDate: "2026-03-22T10:00:00Z",
        endDate: "2026-03-22T11:00:00Z",
        duration: 3600,
        totalDistance: 10000,
        sourceName: "Apple Watch",
      },
    ]);
    vi.mocked(queryWorkoutRoutes).mockResolvedValueOnce([
      { latitude: 37.77, longitude: -122.42, timestamp: "2026-03-22T10:00:00Z" },
    ]);
    client.healthKitSync.pushWorkoutRoutes.mutate.mockRejectedValueOnce(
      new Error("fetch failed: UnexpectedException: The request timed out."),
    );

    const listener = mockAddSampleUpdateListener.mock.calls[0][0];
    listener({
      typeIdentifier: "HKWorkoutTypeIdentifier",
      updateId: "update-1",
    });

    await vi.advanceTimersByTimeAsync(5000);
    await vi.runAllTimersAsync();

    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "bg-healthkit-sync",
      "Background HealthKit upload timed out; retrying on next delivery",
    );
    expect(mockCompleteObserverUpdates).toHaveBeenCalledWith(["update-1"], false);
    vi.useRealTimers();
  });

  it("marks native observer sync lifecycle while draining deliveries (DOFEK-MOBILE-1C)", async () => {
    const client = createMockClient();
    await initBackgroundHealthKitSync(client);
    await vi.waitFor(() => {
      expect(mockSetObserverSyncInProgress).toHaveBeenCalledWith(true);
      expect(mockSetObserverSyncInProgress).toHaveBeenCalledWith(false);
    });
  });

  it("does not report locked-device route errors and marks the observer sync unsuccessful", async () => {
    vi.useFakeTimers();
    const client = createMockClient();
    await initBackgroundHealthKitSync(client);
    await vi.runAllTimersAsync();
    mockCaptureException.mockClear();
    mockCompleteObserverUpdates.mockClear();
    vi.mocked(queryWorkouts).mockResolvedValueOnce([
      {
        uuid: "workout-1",
        activityType: 1,
        startDate: "2026-03-22T10:00:00Z",
        endDate: "2026-03-22T11:00:00Z",
        duration: 3600,
        totalDistance: 10000,
        sourceName: "Apple Watch",
      },
    ]);
    vi.mocked(queryWorkoutRoutes).mockRejectedValueOnce(
      Object.assign(new Error("HealthKit data is unavailable while the device is locked"), {
        code: "HEALTHKIT_DATABASE_INACCESSIBLE",
      }),
    );

    const listener = mockAddSampleUpdateListener.mock.calls[0][0];
    listener({
      typeIdentifier: "HKWorkoutTypeIdentifier",
      updateId: "update-1",
    });

    await vi.advanceTimersByTimeAsync(5000);
    await vi.runAllTimersAsync();

    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "bg-healthkit-sync",
      "Device locked, skipping sync",
    );
    expect(mockCompleteObserverUpdates).toHaveBeenCalledWith(["update-1"], false);
    vi.useRealTimers();
  });

  it("reports partial sync errors without labeling completed stages as succeeded", async () => {
    vi.useFakeTimers();
    const client = createMockClient();
    const onSyncComplete = vi.fn();
    await initBackgroundHealthKitSync(client, onSyncComplete);
    await vi.runAllTimersAsync();
    mockLoggerInfo.mockClear();
    mockCaptureException.mockClear();
    mockCompleteObserverUpdates.mockClear();
    onSyncComplete.mockClear();
    vi.mocked(queryWorkouts).mockResolvedValueOnce([
      {
        uuid: "workout-1",
        activityType: 1,
        startDate: "2026-03-22T10:00:00Z",
        endDate: "2026-03-22T11:00:00Z",
        duration: 3600,
        totalDistance: 10000,
        sourceName: "Apple Watch",
      },
    ]);
    vi.mocked(queryWorkoutRoutes).mockRejectedValueOnce(new Error("Route permission denied"));

    const listener = mockAddSampleUpdateListener.mock.calls[0][0];
    listener({
      typeIdentifier: "HKWorkoutTypeIdentifier",
      updateId: "update-1",
    });

    await vi.advanceTimersByTimeAsync(5000);
    await vi.runAllTimersAsync();

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "bg-healthkit-sync",
      "Sync stage completed",
      expect.objectContaining({
        operation: "queryWorkoutRoutes",
        outcome: "failed",
      }),
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "bg-healthkit-sync",
      expect.stringContaining("HealthKit observer sync completed with 1 error"),
    );
    expect(mockLoggerInfo).not.toHaveBeenCalledWith(
      "bg-healthkit-sync",
      "Sync stage completed",
      expect.objectContaining({
        outcome: "succeeded",
      }),
    );
    expect(onSyncComplete).not.toHaveBeenCalled();
    expect(mockCompleteObserverUpdates).toHaveBeenCalledWith(["update-1"], false);
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("HealthKit observer sync completed with 1 error"),
      }),
      {
        errorCount: 1,
        source: "bg-healthkit-sync",
      },
    );
    vi.useRealTimers();
  });

  it.each([
    null,
    "locked",
    { code: "OTHER_ERROR" },
  ])("reports a non-HealthKit database error to Sentry: %j", async (syncError) => {
    vi.mocked(queryWorkouts).mockRejectedValueOnce(syncError);

    await initBackgroundHealthKitSync(createMockClient());

    await vi.waitFor(() => {
      expect(mockCaptureException).toHaveBeenCalledWith(syncError, {
        source: "bg-healthkit-sync",
      });
    });
  });

  it("skips init when HealthKit is not available", async () => {
    mockIsAvailable.mockReturnValueOnce(false);
    const client = createMockClient();
    await initBackgroundHealthKitSync(client);

    expect(mockSetupBackgroundObservers).not.toHaveBeenCalled();
    expect(mockAddSampleUpdateListener).not.toHaveBeenCalled();
  });

  it("removes previous listener on re-init", async () => {
    const mockRemove = vi.fn();
    mockAddSampleUpdateListener.mockReturnValue({ remove: mockRemove });

    const client = createMockClient();
    await initBackgroundHealthKitSync(client);
    await initBackgroundHealthKitSync(client);

    expect(mockRemove).toHaveBeenCalledTimes(1);
  });

  it("uses the latest client and callback when re-initialized during a running sync", async () => {
    const firstClient = createMockClient();
    const firstSync = createDeferred<{ inserted: number }>();
    firstClient.healthKitSync.pushWorkouts.mutate.mockReturnValueOnce(firstSync.promise);
    vi.mocked(queryWorkouts).mockResolvedValue([
      {
        activityType: 1,
        startDate: "2026-03-22T10:00:00Z",
        endDate: "2026-03-22T11:00:00Z",
        duration: 3600,
        totalDistance: 10000,
      },
    ]);
    const firstOnSyncComplete = vi.fn();
    await initBackgroundHealthKitSync(firstClient, firstOnSyncComplete);
    await vi.waitFor(() => {
      expect(firstClient.healthKitSync.pushWorkouts.mutate).toHaveBeenCalledTimes(1);
    });

    const secondClient = createMockClient();
    const secondOnSyncComplete = vi.fn();
    await initBackgroundHealthKitSync(secondClient, secondOnSyncComplete);
    const secondListener = mockAddSampleUpdateListener.mock.calls[1][0];
    secondListener({
      typeIdentifier: "HKQuantityTypeIdentifierHeartRate",
      updateId: "second-context-update",
    });
    expect(secondClient.healthKitSync.pushWorkouts.mutate).not.toHaveBeenCalled();

    firstSync.resolve({ inserted: 1 });
    await vi.waitFor(() => {
      expect(secondClient.healthKitSync.pushWorkouts.mutate).toHaveBeenCalledTimes(1);
      expect(secondOnSyncComplete).toHaveBeenCalledTimes(2);
      expect(mockCompleteObserverUpdates).toHaveBeenCalledWith(["second-context-update"], true);
    });

    expect(firstClient.healthKitSync.pushWorkouts.mutate).toHaveBeenCalledTimes(1);
    expect(firstOnSyncComplete).not.toHaveBeenCalled();
  });

  it("tears down and reports an observer registration failure", async () => {
    const registrationError = new Error("observer registration failed");
    const mockRemove = vi.fn();
    mockAddSampleUpdateListener.mockReturnValueOnce({ remove: mockRemove });
    mockSetupBackgroundObservers.mockRejectedValueOnce(registrationError);

    await expect(initBackgroundHealthKitSync(createMockClient())).rejects.toBe(registrationError);

    expect(mockRemove).toHaveBeenCalledOnce();
    expect(mockTeardownBackgroundObservers).toHaveBeenCalledOnce();
    expect(mockCaptureException).toHaveBeenCalledWith(registrationError, {
      source: "bg-healthkit-sync",
      operation: "setupBackgroundObservers",
    });
  });

  it("queues an observer update delivered during the initial catch-up sync", async () => {
    vi.useFakeTimers();
    const client = createMockClient();
    const catchUp = createDeferred<{ inserted: number }>();
    client.healthKitSync.pushWorkouts.mutate.mockReturnValueOnce(catchUp.promise);
    vi.mocked(queryWorkouts).mockResolvedValueOnce([
      {
        activityType: 1,
        startDate: "2026-03-22T10:00:00Z",
        endDate: "2026-03-22T11:00:00Z",
        duration: 3600,
        totalDistance: 10000,
      },
    ]);
    await initBackgroundHealthKitSync(client);

    const listener = mockAddSampleUpdateListener.mock.calls[0][0];
    listener({
      typeIdentifier: "HKWorkoutTypeIdentifier",
      updateId: "update-1",
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(mockCompleteObserverUpdates).not.toHaveBeenCalled();

    catchUp.resolve({ inserted: 1 });
    await vi.waitFor(() => {
      expect(mockCompleteObserverUpdates).toHaveBeenCalledWith(["update-1"], true);
    });
    vi.useRealTimers();
  });

  it("preserves an observer update delivered while native registration is finishing", async () => {
    vi.useFakeTimers();
    mockSetupBackgroundObservers.mockImplementationOnce(async () => {
      const listener = mockAddSampleUpdateListener.mock.calls[0][0];
      listener({
        typeIdentifier: "HKQuantityTypeIdentifierStepCount",
        updateId: "registration-update",
      });
      return true;
    });

    await initBackgroundHealthKitSync(createMockClient());
    await vi.advanceTimersByTimeAsync(500);
    await vi.runAllTimersAsync();

    expect(mockCompleteObserverUpdates).toHaveBeenCalledWith(["registration-update"], true);
    vi.useRealTimers();
  });

  it("keeps one observer update outstanding until its sync settles", async () => {
    vi.useFakeTimers();
    const client = createMockClient();
    await initBackgroundHealthKitSync(client);
    await vi.runAllTimersAsync();
    mockCompleteObserverUpdates.mockClear();

    const sync = createDeferred<{ inserted: number }>();
    client.healthKitSync.pushWorkouts.mutate.mockReturnValueOnce(sync.promise);
    vi.mocked(queryWorkouts).mockResolvedValueOnce([
      {
        activityType: 1,
        startDate: "2026-03-22T10:00:00Z",
        endDate: "2026-03-22T11:00:00Z",
        duration: 3600,
        totalDistance: 10000,
      },
    ]);

    const listener = mockAddSampleUpdateListener.mock.calls[0][0];
    listener({
      typeIdentifier: "HKWorkoutTypeIdentifier",
      updateId: "update-1",
    });
    await vi.advanceTimersByTimeAsync(5000);

    expect(mockCompleteObserverUpdates).not.toHaveBeenCalled();

    sync.resolve({ inserted: 1 });
    await vi.waitFor(() => {
      expect(mockCompleteObserverUpdates).toHaveBeenCalledWith(["update-1"], true);
    });
    vi.useRealTimers();
  });

  it("starts observer sync without waiting for a background timer (DOFEK-MOBILE-1C)", async () => {
    const client = createMockClient();
    await initBackgroundHealthKitSync(client);
    await vi.waitFor(() => {
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        "bg-healthkit-sync",
        "Observer processing complete",
        expect.any(Object),
      );
    });
    const startingSyncCount = mockLoggerInfo.mock.calls.filter(
      ([, message]) => message === "Starting sync",
    ).length;
    mockSetObserverSyncInProgress.mockClear();

    const listener = mockAddSampleUpdateListener.mock.calls[0][0];
    listener({
      typeIdentifier: "HKQuantityTypeIdentifierStepCount",
      updateId: "update-1",
    });

    expect(mockSetObserverSyncInProgress).toHaveBeenCalledWith(true);
    expect(
      mockLoggerInfo.mock.calls.filter(([, message]) => message === "Starting sync"),
    ).toHaveLength(startingSyncCount + 1);
    await vi.waitFor(() => {
      expect(mockCompleteObserverUpdates).toHaveBeenCalledWith(["update-1"], true);
    });
  });

  it("keeps observer sync in progress while catch-up is pending", async () => {
    vi.useFakeTimers();
    const client = createMockClient();
    const workoutSync = createDeferred<{ inserted: number }>();
    client.healthKitSync.pushWorkouts.mutate.mockReturnValueOnce(workoutSync.promise);
    mockSetupBackgroundObservers.mockImplementationOnce(async () => {
      const listener = mockAddSampleUpdateListener.mock.calls[0][0];
      listener({
        typeIdentifier: "HKWorkoutTypeIdentifier",
        updateId: "update-during-setup",
      });
      return true;
    });
    mockSetObserverSyncInProgress.mockClear();

    const initPromise = initBackgroundHealthKitSync(client);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSetObserverSyncInProgress).toHaveBeenCalledWith(true);
    expect(mockSetObserverSyncInProgress).not.toHaveBeenCalledWith(false);

    await initPromise;
    expect(mockSetObserverSyncInProgress).not.toHaveBeenCalledWith(false);

    workoutSync.resolve({ inserted: 0 });
    await vi.waitFor(() => {
      expect(mockCompleteObserverUpdates).toHaveBeenCalledWith(["update-during-setup"], true);
    });
    vi.useRealTimers();
  });

  it("serializes observer updates and completes every callback once", async () => {
    vi.useFakeTimers();
    const client = createMockClient();
    await initBackgroundHealthKitSync(client);
    await vi.runAllTimersAsync();
    mockCompleteObserverUpdates.mockClear();

    const listener = mockAddSampleUpdateListener.mock.calls[0][0];
    listener({
      typeIdentifier: "HKQuantityTypeIdentifierStepCount",
      updateId: "update-1",
    });
    await vi.advanceTimersByTimeAsync(400);
    listener({
      typeIdentifier: "HKQuantityTypeIdentifierHeartRate",
      updateId: "update-2",
    });
    await vi.advanceTimersByTimeAsync(500);
    await vi.runAllTimersAsync();

    expect(mockCompleteObserverUpdates).toHaveBeenCalledTimes(2);
    expect(mockCompleteObserverUpdates).toHaveBeenNthCalledWith(1, ["update-1"], true);
    expect(mockCompleteObserverUpdates).toHaveBeenNthCalledWith(2, ["update-2"], true);
    expect(client.healthKitSync.pushWorkouts.mutate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(queryDailyStatistics)).toHaveBeenCalledWith(
      "HKQuantityTypeIdentifierStepCount",
      expect.any(String),
      expect.any(String),
    );
    expect(mockQueryAnchoredSamples).toHaveBeenCalledWith(
      "HKQuantityTypeIdentifierHeartRate",
      expect.any(String),
    );
    vi.useRealTimers();
  });

  it("runs a queued update immediately after the preceding observer sync", async () => {
    vi.useFakeTimers();
    const client = createMockClient();
    await initBackgroundHealthKitSync(client);
    await vi.runAllTimersAsync();
    mockCompleteObserverUpdates.mockClear();

    const firstSync = createDeferred<{
      queryId: string | null;
      samples: HealthKitSample[];
      deletedUUIDs: string[];
    }>();
    mockQueryAnchoredSamples.mockReturnValueOnce(firstSync.promise);

    const listener = mockAddSampleUpdateListener.mock.calls[0][0];
    listener({
      typeIdentifier: "HKQuantityTypeIdentifierHeartRate",
      updateId: "update-1",
    });
    listener({
      typeIdentifier: "HKQuantityTypeIdentifierStepCount",
      updateId: "update-2",
    });

    expect(mockCompleteObserverUpdates).not.toHaveBeenCalled();
    firstSync.resolve({
      queryId: "queued-query",
      samples: [],
      deletedUUIDs: [],
    });
    await vi.waitFor(() => {
      expect(mockCompleteObserverUpdates).toHaveBeenCalledTimes(2);
    });
    expect(mockCompleteObserverUpdates).toHaveBeenNthCalledWith(1, ["update-1"], true);
    expect(mockCompleteObserverUpdates).toHaveBeenLastCalledWith(["update-2"], true);
    vi.useRealTimers();
  });

  it("completes a failed observer batch unsuccessfully and reports the error", async () => {
    vi.useFakeTimers();
    const client = createMockClient();
    await initBackgroundHealthKitSync(client);
    await vi.runAllTimersAsync();
    mockCaptureException.mockClear();
    mockCompleteObserverUpdates.mockClear();

    const networkError = new Error("network timeout");
    client.healthKitSync.pushWorkouts.mutate.mockRejectedValueOnce(networkError);
    vi.mocked(queryWorkouts).mockResolvedValueOnce([
      {
        activityType: 1,
        startDate: "2026-03-22T10:00:00Z",
        endDate: "2026-03-22T11:00:00Z",
        duration: 3600,
        totalDistance: 10000,
      },
    ]);

    const listener = mockAddSampleUpdateListener.mock.calls[0][0];
    listener({
      typeIdentifier: "HKWorkoutTypeIdentifier",
      updateId: "update-1",
    });
    await vi.advanceTimersByTimeAsync(5000);
    await vi.runAllTimersAsync();

    expect(mockCompleteObserverUpdates).toHaveBeenCalledWith(["update-1"], false);
    expect(mockCaptureException).toHaveBeenCalledWith(networkError, {
      source: "bg-healthkit-sync",
    });
    vi.useRealTimers();
  });

  it("reports a native observer acknowledgement failure", async () => {
    vi.useFakeTimers();
    const client = createMockClient();
    await initBackgroundHealthKitSync(client);
    await vi.runAllTimersAsync();
    mockCaptureException.mockClear();
    const acknowledgementError = new Error("native acknowledgement failed");
    mockCompleteObserverUpdates.mockImplementationOnce(() => {
      throw acknowledgementError;
    });

    const listener = mockAddSampleUpdateListener.mock.calls[0][0];
    listener({
      typeIdentifier: "HKQuantityTypeIdentifierStepCount",
      updateId: "update-1",
    });
    await vi.advanceTimersByTimeAsync(500);
    await vi.runAllTimersAsync();

    expect(mockCaptureException).toHaveBeenCalledWith(acknowledgementError, {
      source: "bg-healthkit-sync",
      operation: "completeObserverUpdates",
      updateCount: 1,
    });
    vi.useRealTimers();
  });
});

describe("teardownBackgroundHealthKitSync", () => {
  beforeEach(() => {
    teardownBackgroundHealthKitSync();
    vi.clearAllMocks();
  });

  afterEach(() => {
    teardownBackgroundHealthKitSync();
  });

  it("removes the listener and drains pending native callbacks", async () => {
    vi.useFakeTimers();
    const mockRemove = vi.fn();
    mockAddSampleUpdateListener.mockReturnValue({ remove: mockRemove });

    const client = createMockClient();
    await initBackgroundHealthKitSync(client);
    const listener = mockAddSampleUpdateListener.mock.calls[0][0];
    listener({
      typeIdentifier: "HKQuantityTypeIdentifierStepCount",
      updateId: "update-1",
    });
    teardownBackgroundHealthKitSync();
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();

    expect(mockRemove).toHaveBeenCalledTimes(1);
    expect(mockTeardownBackgroundObservers).toHaveBeenCalledTimes(1);
    expect(mockCompleteObserverUpdates).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("reports a native observer teardown failure", () => {
    const teardownError = new Error("native teardown failed");
    mockTeardownBackgroundObservers.mockImplementationOnce(() => {
      throw teardownError;
    });

    teardownBackgroundHealthKitSync();

    expect(mockCaptureException).toHaveBeenCalledWith(teardownError, {
      source: "bg-healthkit-sync",
      operation: "teardownBackgroundObservers",
    });
  });
});
