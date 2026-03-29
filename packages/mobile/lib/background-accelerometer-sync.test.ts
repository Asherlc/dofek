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
  Platform: { OS: "ios", Version: "17.0" },
}));

const mockIsAccelerometerRecordingAvailable = vi.fn(() => true);
const mockGetMotionAuthorizationStatus = vi.fn(() => "authorized");
const mockRequestMotionPermission = vi.fn(() => Promise.resolve("authorized"));
const mockStartRecording = vi.fn(() => Promise.resolve(true));
const mockIsRecordingActive = vi.fn(() => true);
const mockQueryRecordedData = vi.fn(() => Promise.resolve([]));
const mockGetLastSyncTimestamp = vi.fn((): string | null => null);
const mockSetLastSyncTimestamp = vi.fn();

vi.mock("../modules/core-motion", () => ({
  isAccelerometerRecordingAvailable: (...args: unknown[]) =>
    mockIsAccelerometerRecordingAvailable(...args),
  getMotionAuthorizationStatus: (...args: unknown[]) => mockGetMotionAuthorizationStatus(...args),
  requestMotionPermission: (...args: unknown[]) => mockRequestMotionPermission(...args),
  startRecording: (...args: unknown[]) => mockStartRecording(...args),
  isRecordingActive: (...args: unknown[]) => mockIsRecordingActive(...args),
  queryRecordedData: (...args: unknown[]) => mockQueryRecordedData(...args),
  getLastSyncTimestamp: (...args: unknown[]) => mockGetLastSyncTimestamp(...args),
  setLastSyncTimestamp: (...args: unknown[]) => mockSetLastSyncTimestamp(...args),
}));

const mockSyncInertialMeasurementUnitToServer = vi.fn(() =>
  Promise.resolve({ inserted: 0, recording: true }),
);

vi.mock("./inertial-measurement-unit-sync", () => ({
  syncInertialMeasurementUnitToServer: (...args: unknown[]) =>
    mockSyncInertialMeasurementUnitToServer(...args),
}));

const mockCaptureException = vi.fn();

vi.mock("./telemetry", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const { initBackgroundAccelerometerSync, teardownBackgroundAccelerometerSync } = await import(
  "./background-accelerometer-sync.ts"
);

function makeMockTrpcClient(): InertialMeasurementUnitSyncTrpcClient {
  return {
    inertialMeasurementUnitSync: {
      pushSamples: {
        mutate: vi.fn().mockResolvedValue({ inserted: 0 }),
      },
    },
  };
}

describe("background-accelerometer-sync", () => {
  let trpcClient: InertialMeasurementUnitSyncTrpcClient;

  beforeEach(() => {
    trpcClient = makeMockTrpcClient();
    appStateCallback = null;
    mockRemove.mockClear();
    mockCaptureException.mockClear();
    mockSyncInertialMeasurementUnitToServer.mockReset();
    mockSyncInertialMeasurementUnitToServer.mockResolvedValue({ inserted: 0, recording: true });
    mockIsAccelerometerRecordingAvailable.mockReturnValue(true);
    mockGetMotionAuthorizationStatus.mockReturnValue("authorized");
    vi.mocked(AppState.addEventListener).mockClear();
    teardownBackgroundAccelerometerSync();
  });

  afterEach(() => {
    teardownBackgroundAccelerometerSync();
  });

  it("registers an AppState listener on init", async () => {
    await initBackgroundAccelerometerSync(trpcClient);

    expect(AppState.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("skips init when accelerometer recording is not available", async () => {
    mockIsAccelerometerRecordingAvailable.mockReturnValue(false);

    await initBackgroundAccelerometerSync(trpcClient);

    expect(AppState.addEventListener).not.toHaveBeenCalled();
  });

  it("skips init when motion authorization is denied", async () => {
    mockGetMotionAuthorizationStatus.mockReturnValue("denied");

    await initBackgroundAccelerometerSync(trpcClient);

    expect(AppState.addEventListener).not.toHaveBeenCalled();
  });

  it("calls captureException when foreground sync rejects", async () => {
    await initBackgroundAccelerometerSync(trpcClient);

    const syncError = new Error("sync failed");
    mockSyncInertialMeasurementUnitToServer.mockRejectedValue(syncError);

    appStateCallback?.("active");

    await vi.waitFor(() => {
      expect(mockCaptureException).toHaveBeenCalledWith(syncError, {
        source: "bg-accel-sync",
      });
    });
  });

  it("resets syncing flag after error so next foreground event can sync", async () => {
    await initBackgroundAccelerometerSync(trpcClient);

    mockSyncInertialMeasurementUnitToServer.mockRejectedValue(new Error("first failure"));
    appStateCallback?.("active");

    await vi.waitFor(() => {
      expect(mockCaptureException).toHaveBeenCalled();
    });

    mockCaptureException.mockClear();
    mockSyncInertialMeasurementUnitToServer.mockResolvedValue({ inserted: 5, recording: true });

    appStateCallback?.("active");

    await vi.waitFor(() => {
      expect(mockSyncInertialMeasurementUnitToServer).toHaveBeenCalledTimes(2);
    });
  });

  it("teardown removes the AppState listener", async () => {
    await initBackgroundAccelerometerSync(trpcClient);

    teardownBackgroundAccelerometerSync();

    expect(mockRemove).toHaveBeenCalled();
  });
});
