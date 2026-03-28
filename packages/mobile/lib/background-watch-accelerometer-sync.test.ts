import { AppState } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccelerometerSyncTrpcClient } from "./accelerometer-sync.ts";

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

vi.mock("../modules/watch-motion", () => ({
  isWatchPaired: () => mockIsWatchPaired(),
  isWatchAppInstalled: () => mockIsWatchAppInstalled(),
}));

const mockSyncAccelerometerToServer = vi.fn(() =>
  Promise.resolve({ inserted: 0, recording: true }),
);

vi.mock("./accelerometer-sync", () => ({
  syncAccelerometerToServer: (...args: unknown[]) => mockSyncAccelerometerToServer(...args),
}));

vi.mock("./watch-accelerometer-adapter", () => ({
  createWatchCoreMotionAdapter: vi.fn(() => ({
    isAccelerometerRecordingAvailable: vi.fn(() => true),
    queryRecordedData: vi.fn(() => Promise.resolve([])),
    getLastSyncTimestamp: vi.fn(() => null),
    setLastSyncTimestamp: vi.fn(),
    startRecording: vi.fn(() => Promise.resolve(true)),
    isRecordingActive: vi.fn(() => true),
  })),
}));

const mockCaptureException = vi.fn();
const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

vi.mock("./telemetry", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  logger: mockLogger,
}));

const { initBackgroundWatchAccelerometerSync, teardownBackgroundWatchAccelerometerSync } =
  await import("./background-watch-accelerometer-sync.ts");

function makeMockTrpcClient(): AccelerometerSyncTrpcClient {
  return {
    accelerometerSync: {
      pushAccelerometerSamples: {
        mutate: vi.fn().mockResolvedValue({ inserted: 0 }),
      },
    },
  };
}

describe("background-watch-accelerometer-sync", () => {
  let trpcClient: AccelerometerSyncTrpcClient;

  beforeEach(() => {
    trpcClient = makeMockTrpcClient();
    appStateCallback = null;
    mockRemove.mockClear();
    mockCaptureException.mockClear();
    mockLogger.warn.mockClear();
    mockSyncAccelerometerToServer.mockReset();
    mockSyncAccelerometerToServer.mockResolvedValue({ inserted: 0, recording: true });
    mockIsWatchPaired.mockReturnValue(true);
    mockIsWatchAppInstalled.mockReturnValue(true);
    vi.mocked(AppState.addEventListener).mockClear();
    teardownBackgroundWatchAccelerometerSync();
  });

  afterEach(() => {
    teardownBackgroundWatchAccelerometerSync();
  });

  it("registers an AppState listener and runs initial sync on init", async () => {
    await initBackgroundWatchAccelerometerSync(trpcClient);

    expect(AppState.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    // Initial sync is called immediately during init
    expect(mockSyncAccelerometerToServer).toHaveBeenCalledTimes(1);
  });

  it("skips init when Watch is not paired", async () => {
    mockIsWatchPaired.mockReturnValue(false);

    await initBackgroundWatchAccelerometerSync(trpcClient);

    expect(AppState.addEventListener).not.toHaveBeenCalled();
  });

  it("skips init when Watch app is not installed", async () => {
    mockIsWatchAppInstalled.mockReturnValue(false);

    await initBackgroundWatchAccelerometerSync(trpcClient);

    expect(AppState.addEventListener).not.toHaveBeenCalled();
  });

  it("calls captureException when foreground sync rejects", async () => {
    await initBackgroundWatchAccelerometerSync(trpcClient);

    const syncError = new Error("watch sync failed");
    mockSyncAccelerometerToServer.mockRejectedValue(syncError);

    appStateCallback?.("active");

    await vi.waitFor(() => {
      expect(mockCaptureException).toHaveBeenCalledWith(syncError, {
        source: "bg-watch-accel-sync",
      });
    });
  });

  it("logs warning when foreground sync rejects", async () => {
    await initBackgroundWatchAccelerometerSync(trpcClient);

    mockSyncAccelerometerToServer.mockRejectedValue(new Error("bluetooth disconnected"));

    appStateCallback?.("active");

    await vi.waitFor(() => {
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "bg-watch-accel-sync",
        expect.stringContaining("bluetooth disconnected"),
      );
    });
  });

  it("resets syncing flag after error so next foreground event can sync", async () => {
    await initBackgroundWatchAccelerometerSync(trpcClient);

    mockSyncAccelerometerToServer.mockRejectedValue(new Error("first failure"));
    appStateCallback?.("active");

    await vi.waitFor(() => {
      expect(mockCaptureException).toHaveBeenCalled();
    });

    mockCaptureException.mockClear();
    mockSyncAccelerometerToServer.mockResolvedValue({ inserted: 3, recording: true });

    appStateCallback?.("active");

    await vi.waitFor(() => {
      // Initial sync (1) + first foreground (2) + second foreground (3)
      expect(mockSyncAccelerometerToServer).toHaveBeenCalledTimes(3);
    });
  });

  it("teardown removes the AppState listener", async () => {
    await initBackgroundWatchAccelerometerSync(trpcClient);

    teardownBackgroundWatchAccelerometerSync();

    expect(mockRemove).toHaveBeenCalled();
  });
});
