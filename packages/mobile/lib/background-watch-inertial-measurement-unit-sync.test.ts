import { AppState } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InertialMeasurementUnitSyncTrpcClient } from "./inertial-measurement-unit-sync.ts";

let appStateCallback: ((state: string) => void) | null = null;
const mockRemove = vi.fn();

vi.mock("react-native", () => ({
  AppState: {
    addEventListener: vi
      .fn()
      .mockImplementation((_event: string, callback: (state: string) => void) => {
        appStateCallback = callback;
        return { remove: mockRemove };
      }),
  },
}));

const mockIsWatchPaired = vi.fn(() => true);
const mockIsWatchAppInstalled = vi.fn(() => true);
const mockRequestWatchRecording = vi.fn(() => Promise.resolve(true));

vi.mock("../modules/watch-motion", () => ({
  isWatchPaired: () => mockIsWatchPaired(),
  isWatchAppInstalled: () => mockIsWatchAppInstalled(),
  requestWatchRecording: () => mockRequestWatchRecording(),
}));

const mockSyncWatchInertialMeasurementUnitFiles = vi.fn(() =>
  Promise.resolve({ totalInserted: 0, filesProcessed: 0, filesFailed: 0 }),
);

vi.mock("./watch-file-sync", () => ({
  syncWatchAccelerometerFiles: (...args: unknown[]) =>
    mockSyncWatchInertialMeasurementUnitFiles(...args),
}));

const mockCaptureException = vi.fn();

vi.mock("./telemetry", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  initBackgroundWatchInertialMeasurementUnitSync,
  teardownBackgroundWatchInertialMeasurementUnitSync,
} = await import("./background-watch-inertial-measurement-unit-sync.ts");

function makeMockTrpcClient(): InertialMeasurementUnitSyncTrpcClient {
  return {
    inertialMeasurementUnitSync: {
      pushSamples: {
        mutate: vi.fn().mockResolvedValue({ inserted: 0 }),
      },
    },
  };
}

describe("background-watch-inertial-measurement-unit-sync", () => {
  let trpcClient: InertialMeasurementUnitSyncTrpcClient;

  beforeEach(() => {
    trpcClient = makeMockTrpcClient();
    appStateCallback = null;
    mockRemove.mockClear();
    mockCaptureException.mockClear();
    mockSyncWatchInertialMeasurementUnitFiles.mockReset();
    mockSyncWatchInertialMeasurementUnitFiles.mockResolvedValue({
      totalInserted: 0,
      filesProcessed: 0,
      filesFailed: 0,
    });
    mockIsWatchPaired.mockReturnValue(true);
    mockIsWatchAppInstalled.mockReturnValue(true);
    mockRequestWatchRecording.mockReset();
    mockRequestWatchRecording.mockResolvedValue(true);
    vi.mocked(AppState.addEventListener).mockClear();
    teardownBackgroundWatchInertialMeasurementUnitSync();
  });

  afterEach(() => {
    teardownBackgroundWatchInertialMeasurementUnitSync();
  });

  it("registers an AppState listener and runs initial sync on init", async () => {
    await initBackgroundWatchInertialMeasurementUnitSync(trpcClient);

    expect(AppState.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    // Initial sync is called immediately during init
    expect(mockSyncWatchInertialMeasurementUnitFiles).toHaveBeenCalledTimes(1);
    expect(mockSyncWatchInertialMeasurementUnitFiles).toHaveBeenCalledWith(trpcClient);
  });

  it("requests Watch recording after sync", async () => {
    await initBackgroundWatchInertialMeasurementUnitSync(trpcClient);

    expect(mockRequestWatchRecording).toHaveBeenCalledTimes(1);
  });

  it("skips init when Watch is not paired", async () => {
    mockIsWatchPaired.mockReturnValue(false);

    await initBackgroundWatchInertialMeasurementUnitSync(trpcClient);

    expect(AppState.addEventListener).not.toHaveBeenCalled();
  });

  it("skips init when Watch app is not installed", async () => {
    mockIsWatchAppInstalled.mockReturnValue(false);

    await initBackgroundWatchInertialMeasurementUnitSync(trpcClient);

    expect(AppState.addEventListener).not.toHaveBeenCalled();
  });

  it("calls captureException when foreground sync rejects", async () => {
    await initBackgroundWatchInertialMeasurementUnitSync(trpcClient);

    const syncError = new Error("watch sync failed");
    mockSyncWatchInertialMeasurementUnitFiles.mockRejectedValue(syncError);

    appStateCallback?.("active");

    await vi.waitFor(() => {
      expect(mockCaptureException).toHaveBeenCalledWith(syncError, {
        source: "bg-watch-accel-sync",
      });
    });
  });

  it("resets syncing flag after error so next foreground event can sync", async () => {
    await initBackgroundWatchInertialMeasurementUnitSync(trpcClient);

    mockSyncWatchInertialMeasurementUnitFiles.mockRejectedValue(new Error("first failure"));
    appStateCallback?.("active");

    await vi.waitFor(() => {
      expect(mockCaptureException).toHaveBeenCalled();
    });

    mockCaptureException.mockClear();
    mockSyncWatchInertialMeasurementUnitFiles.mockResolvedValue({
      totalInserted: 3,
      filesProcessed: 1,
      filesFailed: 0,
    });

    appStateCallback?.("active");

    await vi.waitFor(() => {
      // Initial sync (1) + first foreground (2) + second foreground (3)
      expect(mockSyncWatchInertialMeasurementUnitFiles).toHaveBeenCalledTimes(3);
    });
  });

  it("teardown removes the AppState listener", async () => {
    await initBackgroundWatchInertialMeasurementUnitSync(trpcClient);

    teardownBackgroundWatchInertialMeasurementUnitSync();

    expect(mockRemove).toHaveBeenCalled();
  });
});
