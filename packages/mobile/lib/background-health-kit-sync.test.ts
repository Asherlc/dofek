import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSetupBackgroundObservers = vi.fn().mockResolvedValue(true);
const mockAddSampleUpdateListener = vi.fn().mockReturnValue({ remove: vi.fn() });
const mockHasEverAuthorized = vi.fn().mockReturnValue(true);
const mockIsAvailable = vi.fn().mockReturnValue(true);
const mockCaptureException = vi.fn();
const mockLoggerInfo = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();

vi.mock("../modules/health-kit", () => ({
  isAvailable: (...args: unknown[]) => mockIsAvailable(...args),
  hasEverAuthorized: (...args: unknown[]) => mockHasEverAuthorized(...args),
  setupBackgroundObservers: (...args: unknown[]) => mockSetupBackgroundObservers(...args),
  addSampleUpdateListener: (...args: unknown[]) => mockAddSampleUpdateListener(...args),
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
    vi.clearAllMocks();
    teardownBackgroundHealthKitSync();
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

  it("skips setup when HealthKit was never authorized", async () => {
    mockHasEverAuthorized.mockReturnValueOnce(false);
    const client = createMockClient();
    await initBackgroundHealthKitSync(client);

    expect(mockSetupBackgroundObservers).not.toHaveBeenCalled();
    expect(mockAddSampleUpdateListener).not.toHaveBeenCalled();
  });

  it("proceeds with sync when previously authorized even if new types need permission", async () => {
    // hasEverAuthorized returns true (default mock) — sync should proceed
    // regardless of what getRequestStatus would return
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
    listener();

    // Advance past debounce timer
    await vi.advanceTimersByTimeAsync(5000);
    // Let sync promises resolve
    await vi.runAllTimersAsync();

    expect(onSyncComplete).toHaveBeenCalledTimes(1);
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
        totalEnergyBurned: 500,
        totalDistance: 10000,
      },
    ]);
    const client = createMockClient();
    client.healthKitSync.pushWorkouts.mutate.mockRejectedValue(new Error("network"));
    const onSyncComplete = vi.fn();
    await initBackgroundHealthKitSync(client, onSyncComplete);

    const listener = mockAddSampleUpdateListener.mock.calls[0][0];
    listener();

    await vi.advanceTimersByTimeAsync(5000);
    await vi.runAllTimersAsync();

    expect(onSyncComplete).not.toHaveBeenCalled();
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
        totalEnergyBurned: 500,
        totalDistance: 10000,
      },
    ]);
    const client = createMockClient();
    const networkError = new Error("network timeout");
    client.healthKitSync.pushWorkouts.mutate.mockRejectedValue(networkError);
    await initBackgroundHealthKitSync(client);

    const listener = mockAddSampleUpdateListener.mock.calls[0][0];
    listener();

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
      new Error("Protected health data is inaccessible"),
    );
    const client = createMockClient();
    await initBackgroundHealthKitSync(client);

    const listener = mockAddSampleUpdateListener.mock.calls[0][0];
    listener();

    await vi.advanceTimersByTimeAsync(5000);
    await vi.runAllTimersAsync();

    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "bg-healthkit-sync",
      "Device locked, skipping sync",
    );
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
    teardownBackgroundHealthKitSync();

    expect(mockRemove).toHaveBeenCalledTimes(1);
  });
});
