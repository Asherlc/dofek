import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSetupBackgroundObservers = vi.fn().mockResolvedValue(true);
const mockTeardownBackgroundObservers = vi.fn();
const mockAddSampleUpdateListener = vi.fn().mockReturnValue({ remove: vi.fn() });
const mockCompleteBackgroundDelivery = vi.fn().mockReturnValue(true);
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
  teardownBackgroundObservers: (...args: unknown[]) => mockTeardownBackgroundObservers(...args),
  addSampleUpdateListener: (...args: unknown[]) => mockAddSampleUpdateListener(...args),
  completeBackgroundDelivery: (...args: unknown[]) => mockCompleteBackgroundDelivery(...args),
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

import { queryWorkouts } from "../modules/health-kit";
import {
  initBackgroundHealthKitSync,
  teardownBackgroundHealthKitSync,
} from "./background-health-kit-sync";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (!resolvePromise) throw new Error("Deferred promise was not initialized");
      resolvePromise(value);
    },
  };
}

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
      typeIdentifier: "HKQuantityTypeIdentifierHeartRate",
      deliveryId: "delivery-success",
    });

    // Advance past debounce timer
    await vi.advanceTimersByTimeAsync(5000);
    // Let sync promises resolve
    await vi.runAllTimersAsync();

    expect(onSyncComplete).toHaveBeenCalledTimes(2);
    expect(mockCompleteBackgroundDelivery).toHaveBeenCalledWith("delivery-success");
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
      typeIdentifier: "HKQuantityTypeIdentifierHeartRate",
      deliveryId: "delivery-failure",
    });

    await vi.advanceTimersByTimeAsync(5000);
    await vi.runAllTimersAsync();

    expect(onSyncComplete).not.toHaveBeenCalled();
    expect(mockCompleteBackgroundDelivery).toHaveBeenCalledWith("delivery-failure");
    vi.useRealTimers();
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
      typeIdentifier: "HKQuantityTypeIdentifierHeartRate",
      deliveryId: "delivery-network-error",
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
    vi.mocked(queryWorkouts).mockRejectedValueOnce(
      Object.assign(new Error("HealthKit data is unavailable while the device is locked"), {
        code: "HEALTHKIT_DATABASE_INACCESSIBLE",
      }),
    );
    const client = createMockClient();
    await initBackgroundHealthKitSync(client);

    const listener = mockAddSampleUpdateListener.mock.calls[0][0];
    listener({
      typeIdentifier: "HKQuantityTypeIdentifierHeartRate",
      deliveryId: "delivery-locked",
    });

    await vi.advanceTimersByTimeAsync(5000);
    await vi.runAllTimersAsync();

    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "bg-healthkit-sync",
      "Device locked, skipping sync",
    );
    expect(mockCompleteBackgroundDelivery).toHaveBeenCalledWith("delivery-locked");
    vi.useRealTimers();
  });

  it("does not acknowledge a delivery until its sync attempt finishes", async () => {
    vi.useFakeTimers();
    const client = createMockClient();
    await initBackgroundHealthKitSync(client);
    await vi.waitFor(() => {
      expect(client.healthKitSync.pushWorkouts.mutate).toHaveBeenCalledTimes(1);
    });

    const upload = deferred<{ inserted: number }>();
    client.healthKitSync.pushWorkouts.mutate.mockClear();
    client.healthKitSync.pushWorkouts.mutate.mockReturnValueOnce(upload.promise);
    const listener = mockAddSampleUpdateListener.mock.calls[0][0];
    listener({
      typeIdentifier: "HKQuantityTypeIdentifierHeartRate",
      deliveryId: "delivery-deferred",
    });

    expect(mockCompleteBackgroundDelivery).not.toHaveBeenCalledWith("delivery-deferred");
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.healthKitSync.pushWorkouts.mutate).toHaveBeenCalledTimes(1);
    expect(mockCompleteBackgroundDelivery).not.toHaveBeenCalledWith("delivery-deferred");

    upload.resolve({ inserted: 0 });
    await vi.waitFor(() => {
      expect(mockCompleteBackgroundDelivery).toHaveBeenCalledWith("delivery-deferred");
    });
    vi.useRealTimers();
  });

  it("queues a follow-up sync for a delivery received during an active sync", async () => {
    vi.useFakeTimers();
    const client = createMockClient();
    await initBackgroundHealthKitSync(client);
    await vi.waitFor(() => {
      expect(client.healthKitSync.pushWorkouts.mutate).toHaveBeenCalledTimes(1);
    });

    const firstUpload = deferred<{ inserted: number }>();
    const secondUpload = deferred<{ inserted: number }>();
    client.healthKitSync.pushWorkouts.mutate.mockClear();
    client.healthKitSync.pushWorkouts.mutate
      .mockReturnValueOnce(firstUpload.promise)
      .mockReturnValueOnce(secondUpload.promise);
    const listener = mockAddSampleUpdateListener.mock.calls[0][0];

    listener({
      typeIdentifier: "HKQuantityTypeIdentifierHeartRate",
      deliveryId: "delivery-first",
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.healthKitSync.pushWorkouts.mutate).toHaveBeenCalledTimes(1);

    listener({
      typeIdentifier: "HKQuantityTypeIdentifierRestingHeartRate",
      deliveryId: "delivery-second",
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.healthKitSync.pushWorkouts.mutate).toHaveBeenCalledTimes(1);

    listener({
      typeIdentifier: "HKQuantityTypeIdentifierStepCount",
      deliveryId: "delivery-third",
    });

    firstUpload.resolve({ inserted: 0 });
    await vi.waitFor(() => {
      expect(mockCompleteBackgroundDelivery).toHaveBeenCalledWith("delivery-first");
      expect(client.healthKitSync.pushWorkouts.mutate).toHaveBeenCalledTimes(2);
    });
    expect(mockCompleteBackgroundDelivery).not.toHaveBeenCalledWith("delivery-second");
    expect(mockCompleteBackgroundDelivery).not.toHaveBeenCalledWith("delivery-third");

    secondUpload.resolve({ inserted: 0 });
    await vi.waitFor(() => {
      expect(mockCompleteBackgroundDelivery).toHaveBeenCalledWith("delivery-second");
      expect(mockCompleteBackgroundDelivery).toHaveBeenCalledWith("delivery-third");
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.healthKitSync.pushWorkouts.mutate).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
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
});

describe("teardownBackgroundHealthKitSync", () => {
  it("removes the listener and clears timers", async () => {
    const mockRemove = vi.fn();
    mockAddSampleUpdateListener.mockReturnValue({ remove: mockRemove });

    const client = createMockClient();
    await initBackgroundHealthKitSync(client);
    mockTeardownBackgroundObservers.mockClear();
    teardownBackgroundHealthKitSync();

    expect(mockRemove).toHaveBeenCalledTimes(1);
    expect(mockTeardownBackgroundObservers).toHaveBeenCalledTimes(1);
  });

  it("acknowledges deliveries still waiting for their debounce timer", async () => {
    vi.useFakeTimers();
    const client = createMockClient();
    await initBackgroundHealthKitSync(client);
    const listener = mockAddSampleUpdateListener.mock.calls[0][0];
    listener({
      typeIdentifier: "HKQuantityTypeIdentifierHeartRate",
      deliveryId: "delivery-pending-teardown",
    });

    teardownBackgroundHealthKitSync();

    expect(mockCompleteBackgroundDelivery).toHaveBeenCalledWith("delivery-pending-teardown");
    vi.useRealTimers();
  });
});
