import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSetupBackgroundObservers = vi.fn().mockResolvedValue(true);
const mockAddSampleUpdateListener = vi.fn().mockReturnValue({ remove: vi.fn() });
const mockGetRequestStatus = vi.fn().mockResolvedValue("unnecessary");

vi.mock("../modules/health-kit", () => ({
  isAvailable: () => true,
  getRequestStatus: (...args: unknown[]) => mockGetRequestStatus(...args),
  setupBackgroundObservers: (...args: unknown[]) => mockSetupBackgroundObservers(...args),
  addSampleUpdateListener: (...args: unknown[]) => mockAddSampleUpdateListener(...args),
  queryDailyStatistics: vi.fn().mockResolvedValue([]),
  queryQuantitySamples: vi.fn().mockResolvedValue([]),
  queryWorkouts: vi.fn().mockResolvedValue([]),
  querySleepSamples: vi.fn().mockResolvedValue([]),
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

  it("skips setup when permissions not granted", async () => {
    mockGetRequestStatus.mockResolvedValueOnce("shouldRequest");
    const client = createMockClient();
    await initBackgroundHealthKitSync(client);

    expect(mockSetupBackgroundObservers).not.toHaveBeenCalled();
    expect(mockAddSampleUpdateListener).not.toHaveBeenCalled();
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
      { activityType: 1, startDate: "2026-03-22T10:00:00Z", endDate: "2026-03-22T11:00:00Z", duration: 3600, totalEnergyBurned: 500, totalDistance: 10000 },
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
