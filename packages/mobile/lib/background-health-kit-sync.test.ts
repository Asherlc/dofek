import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSetupBackgroundObservers = vi.fn().mockResolvedValue(true);
const mockAddSampleUpdateListener = vi.fn().mockReturnValue({ remove: vi.fn() });
const mockCompleteObserverUpdates = vi.fn().mockReturnValue(0);
const mockTeardownBackgroundObservers = vi.fn().mockReturnValue(0);
const mockHasEverAuthorized = vi.fn().mockReturnValue(true);
const mockIsAvailable = vi.fn().mockReturnValue(true);
const mockGetRequestStatus = vi.fn().mockResolvedValue("unnecessary");
const mockRequestPermissions = vi.fn().mockResolvedValue(true);
const mockCaptureException = vi.fn();
const mockLoggerInfo = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();

vi.mock("../modules/health-kit", () => ({
  isAvailable: (...args: unknown[]) => mockIsAvailable(...args),
  hasEverAuthorized: (...args: unknown[]) => mockHasEverAuthorized(...args),
  getRequestStatus: (...args: unknown[]) => mockGetRequestStatus(...args),
  requestPermissions: (...args: unknown[]) => mockRequestPermissions(...args),
  setupBackgroundObservers: (...args: unknown[]) => mockSetupBackgroundObservers(...args),
  addSampleUpdateListener: (...args: unknown[]) => mockAddSampleUpdateListener(...args),
  completeObserverUpdates: (...args: unknown[]) => mockCompleteObserverUpdates(...args),
  teardownBackgroundObservers: (...args: unknown[]) => mockTeardownBackgroundObservers(...args),
  queryDailyStatistics: vi.fn().mockResolvedValue([]),
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

import { queryWorkoutRoutes, queryWorkouts } from "../modules/health-kit";
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

    // Advance past debounce timer
    await vi.advanceTimersByTimeAsync(5000);
    // Let sync promises resolve
    await vi.runAllTimersAsync();

    expect(onSyncComplete).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does not call onSyncComplete on sync failure", async () => {
    vi.useFakeTimers();
    // Return workout data so pushWorkouts.mutate gets called
    vi.mocked(queryWorkouts).mockResolvedValueOnce([
      {
        activityType: 1,
        startDate: "2026-03-22T10:00:00Z",
        endDate: "2026-03-22T11:00:00Z",
        duration: 3600,
        totalDistance: 10000,
      },
    ]);
    const client = createMockClient();
    client.healthKitSync.pushWorkouts.mutate.mockRejectedValue(new Error("network"));
    const onSyncComplete = vi.fn();
    await initBackgroundHealthKitSync(client, onSyncComplete);

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
    vi.mocked(queryWorkouts).mockResolvedValueOnce([
      {
        activityType: 1,
        startDate: "2026-03-22T10:00:00Z",
        endDate: "2026-03-22T11:00:00Z",
        duration: 3600,
        totalDistance: 10000,
      },
    ]);
    const client = createMockClient();
    const networkError = new Error("network timeout");
    client.healthKitSync.pushWorkouts.mutate.mockRejectedValue(networkError);
    await initBackgroundHealthKitSync(client);

    const listener = mockAddSampleUpdateListener.mock.calls[0][0];
    listener({
      typeIdentifier: "HKQuantityTypeIdentifierStepCount",
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
      typeIdentifier: "HKQuantityTypeIdentifierStepCount",
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
      typeIdentifier: "HKQuantityTypeIdentifierStepCount",
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
    vi.mocked(queryWorkouts).mockResolvedValueOnce([
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

    const secondClient = createMockClient();
    const secondOnSyncComplete = vi.fn();
    await initBackgroundHealthKitSync(secondClient, secondOnSyncComplete);
    expect(secondClient.healthKitSync.pushWorkouts.mutate).not.toHaveBeenCalled();

    firstSync.resolve({ inserted: 1 });
    await vi.waitFor(() => {
      expect(secondClient.healthKitSync.pushWorkouts.mutate).toHaveBeenCalledTimes(1);
    });

    expect(firstOnSyncComplete).toHaveBeenCalledTimes(1);
    expect(secondOnSyncComplete).toHaveBeenCalledTimes(1);
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
      typeIdentifier: "HKQuantityTypeIdentifierStepCount",
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
      typeIdentifier: "HKQuantityTypeIdentifierStepCount",
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

  it("coalesces debounced observer updates and completes every callback once", async () => {
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

    expect(mockCompleteObserverUpdates).toHaveBeenCalledTimes(1);
    expect(mockCompleteObserverUpdates).toHaveBeenCalledWith(["update-1", "update-2"], true);
    expect(client.healthKitSync.pushWorkouts.mutate).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("debounces an update received while the preceding observer sync is still running", async () => {
    vi.useFakeTimers();
    const client = createMockClient();
    await initBackgroundHealthKitSync(client);
    await vi.runAllTimersAsync();
    mockCompleteObserverUpdates.mockClear();

    const firstSync = createDeferred<{ inserted: number }>();
    client.healthKitSync.pushWorkouts.mutate.mockReturnValueOnce(firstSync.promise);
    vi.mocked(queryWorkouts)
      .mockResolvedValueOnce([
        {
          activityType: 1,
          startDate: "2026-03-22T10:00:00Z",
          endDate: "2026-03-22T11:00:00Z",
          duration: 3600,
          totalDistance: 10000,
        },
      ])
      .mockResolvedValueOnce([
        {
          activityType: 1,
          startDate: "2026-03-22T12:00:00Z",
          endDate: "2026-03-22T13:00:00Z",
          duration: 3600,
          totalDistance: 10000,
        },
      ]);

    const listener = mockAddSampleUpdateListener.mock.calls[0][0];
    listener({
      typeIdentifier: "HKQuantityTypeIdentifierStepCount",
      updateId: "update-1",
    });
    await vi.advanceTimersByTimeAsync(500);
    listener({
      typeIdentifier: "HKQuantityTypeIdentifierHeartRate",
      updateId: "update-2",
    });

    firstSync.resolve({ inserted: 1 });
    await vi.advanceTimersByTimeAsync(499);
    expect(mockCompleteObserverUpdates).toHaveBeenCalledTimes(1);
    expect(mockCompleteObserverUpdates).toHaveBeenCalledWith(["update-1"], true);

    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();
    expect(mockCompleteObserverUpdates).toHaveBeenCalledTimes(2);
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
      typeIdentifier: "HKQuantityTypeIdentifierStepCount",
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

  it("removes the listener, clears timers, and drains pending native callbacks", async () => {
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
