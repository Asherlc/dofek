import { AppState } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WatchSyncTrpcClient } from "./background-watch-inertial-measurement-unit-sync.ts";

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
const mockEnableAccountSync = vi.fn(() => Promise.resolve(true));

vi.mock("../modules/watch-motion", () => ({
  enableAccountSync: () => mockEnableAccountSync(),
  isWatchPaired: () => mockIsWatchPaired(),
  isWatchAppInstalled: () => mockIsWatchAppInstalled(),
  requestWatchRecording: () => mockRequestWatchRecording(),
}));

const mockSyncWatchInertialMeasurementUnitFiles = vi.fn(() =>
  Promise.resolve({ totalInserted: 0, filesProcessed: 0, filesFailed: 0 }),
);
const mockSyncWatchAltitudeFiles = vi.fn(() =>
  Promise.resolve({ totalInserted: 0, filesProcessed: 0, filesFailed: 0 }),
);

vi.mock("./watch-file-sync", () => ({
  syncWatchAccelerometerFiles: (...args: unknown[]) =>
    mockSyncWatchInertialMeasurementUnitFiles(...args),
}));

vi.mock("./watch-altitude-file-sync", () => ({
  syncWatchAltitudeFiles: (...args: unknown[]) => mockSyncWatchAltitudeFiles(...args),
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

function makeMockTrpcClient(): WatchSyncTrpcClient {
  return {
    inertialMeasurementUnitSync: {
      pushSamples: {
        mutate: vi.fn().mockResolvedValue({ inserted: 0 }),
      },
    },
    watchAltitudeSync: {
      pushSamples: {
        mutate: vi.fn().mockResolvedValue({ inserted: 0 }),
      },
    },
  };
}

describe("background-watch-inertial-measurement-unit-sync", () => {
  let trpcClient: WatchSyncTrpcClient;

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
    mockSyncWatchAltitudeFiles.mockReset();
    mockSyncWatchAltitudeFiles.mockResolvedValue({
      totalInserted: 0,
      filesProcessed: 0,
      filesFailed: 0,
    });
    mockIsWatchPaired.mockReturnValue(true);
    mockIsWatchAppInstalled.mockReturnValue(true);
    mockRequestWatchRecording.mockReset();
    mockRequestWatchRecording.mockResolvedValue(true);
    mockEnableAccountSync.mockClear();
    mockEnableAccountSync.mockResolvedValue(true);
    vi.mocked(AppState.addEventListener).mockClear();
    teardownBackgroundWatchInertialMeasurementUnitSync();
  });

  afterEach(() => {
    teardownBackgroundWatchInertialMeasurementUnitSync();
  });

  it("registers an AppState listener and runs initial sync on init", async () => {
    await initBackgroundWatchInertialMeasurementUnitSync(trpcClient);

    expect(AppState.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    expect(mockSyncWatchInertialMeasurementUnitFiles).toHaveBeenCalledTimes(1);
    expect(mockSyncWatchInertialMeasurementUnitFiles).toHaveBeenCalledWith(trpcClient);
    expect(mockSyncWatchAltitudeFiles).toHaveBeenCalledTimes(1);
    expect(mockSyncWatchAltitudeFiles).toHaveBeenCalledWith(trpcClient);
  });

  it("requests Watch recording after sync", async () => {
    await initBackgroundWatchInertialMeasurementUnitSync(trpcClient);

    expect(mockRequestWatchRecording).toHaveBeenCalledTimes(1);
  });

  it("re-enables account sync before reading pending Watch files", async () => {
    await initBackgroundWatchInertialMeasurementUnitSync(trpcClient);

    expect(mockEnableAccountSync).toHaveBeenCalledOnce();
    expect(mockEnableAccountSync.mock.invocationCallOrder[0]).toBeLessThan(
      mockSyncWatchInertialMeasurementUnitFiles.mock.invocationCallOrder[0] ?? Infinity,
    );
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

  it("calls captureException when accelerometer sync throws during init", async () => {
    mockSyncWatchInertialMeasurementUnitFiles.mockRejectedValue(new Error("watch sync failed"));

    await initBackgroundWatchInertialMeasurementUnitSync(trpcClient);

    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
      source: "bg-watch-sync:accelerometer",
    });
    expect(mockSyncWatchAltitudeFiles).toHaveBeenCalledTimes(1);
  });

  it("queues another foreground sync after a prior sync failure completes", async () => {
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

  it("continues altitude sync when accelerometer sync throws", async () => {
    mockSyncWatchInertialMeasurementUnitFiles.mockRejectedValue(new Error("accel sync failed"));

    await initBackgroundWatchInertialMeasurementUnitSync(trpcClient);

    expect(mockSyncWatchAltitudeFiles).toHaveBeenCalledTimes(1);
    expect(mockRequestWatchRecording).toHaveBeenCalledTimes(1);
  });

  it("calls captureException when altitude sync throws during foreground sync", async () => {
    await initBackgroundWatchInertialMeasurementUnitSync(trpcClient);

    mockSyncWatchAltitudeFiles.mockRejectedValue(new Error("altitude sync failed"));
    appStateCallback?.("active");

    await vi.waitFor(() => {
      expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
        source: "bg-watch-sync:altitude",
      });
    });
  });

  it("teardown removes the AppState listener", async () => {
    await initBackgroundWatchInertialMeasurementUnitSync(trpcClient);

    teardownBackgroundWatchInertialMeasurementUnitSync();

    expect(mockRemove).toHaveBeenCalled();
  });
});
