import { AppState } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccelerometerSyncTrpcClient } from "./accelerometer-sync.ts";
import {
  initBackgroundAccelerometerSync,
  teardownBackgroundAccelerometerSync,
} from "./background-accelerometer-sync.ts";

const mockCaptureException = vi.fn();
const mockLoggerWarn = vi.fn();

vi.mock("./telemetry", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  logger: {
    info: vi.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: vi.fn(),
  },
}));

const mockSyncAccelerometerToServer = vi.fn().mockResolvedValue(undefined);

vi.mock("./accelerometer-sync", () => ({
  syncAccelerometerToServer: (...args: unknown[]) => mockSyncAccelerometerToServer(...args),
}));

const mockIsAvailable = vi.fn().mockReturnValue(true);
const mockGetMotionAuthorizationStatus = vi.fn().mockReturnValue("authorized");
const mockRequestMotionPermission = vi.fn().mockResolvedValue("authorized");
const mockStartRecording = vi.fn().mockResolvedValue(true);
const mockIsRecordingActive = vi.fn().mockReturnValue(true);
const mockQueryRecordedData = vi.fn().mockResolvedValue([]);
const mockGetLastSyncTimestamp = vi.fn().mockReturnValue(null);
const mockSetLastSyncTimestamp = vi.fn();

vi.mock("../modules/core-motion", () => ({
  isAccelerometerRecordingAvailable: () => mockIsAvailable(),
  getMotionAuthorizationStatus: () => mockGetMotionAuthorizationStatus(),
  requestMotionPermission: () => mockRequestMotionPermission(),
  startRecording: (...args: unknown[]) => mockStartRecording(...args),
  isRecordingActive: () => mockIsRecordingActive(),
  queryRecordedData: (...args: unknown[]) => mockQueryRecordedData(...args),
  getLastSyncTimestamp: () => mockGetLastSyncTimestamp(),
  setLastSyncTimestamp: (...args: unknown[]) => mockSetLastSyncTimestamp(...args),
}));

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

function makeMockTrpcClient(): AccelerometerSyncTrpcClient {
  return {
    accelerometerSync: {
      pushAccelerometerSamples: {
        mutate: vi.fn().mockResolvedValue({ inserted: 0 }),
      },
    },
  };
}

describe("background-accelerometer-sync", () => {
  let trpcClient: AccelerometerSyncTrpcClient;

  beforeEach(() => {
    trpcClient = makeMockTrpcClient();
    appStateCallback = null;
    mockRemove.mockClear();
    mockCaptureException.mockClear();
    mockLoggerWarn.mockClear();
    mockSyncAccelerometerToServer.mockResolvedValue(undefined);
    vi.mocked(AppState.addEventListener).mockClear();
    teardownBackgroundAccelerometerSync();
  });

  afterEach(() => {
    teardownBackgroundAccelerometerSync();
  });

  it("calls captureException when foreground sync rejects", async () => {
    await initBackgroundAccelerometerSync(trpcClient);

    const syncError = new Error("sync upload failed");
    mockSyncAccelerometerToServer.mockRejectedValue(syncError);

    // Trigger foreground event
    appStateCallback?.("active");

    await vi.waitFor(() => {
      expect(mockCaptureException).toHaveBeenCalledWith(syncError, {
        source: "bg-accel-sync",
      });
    });
  });

  it("does not crash when foreground sync rejects", async () => {
    await initBackgroundAccelerometerSync(trpcClient);

    mockSyncAccelerometerToServer.mockRejectedValue(new Error("network error"));

    // Should not throw
    appStateCallback?.("active");

    await vi.waitFor(() => {
      expect(mockCaptureException).toHaveBeenCalled();
    });
  });
});
