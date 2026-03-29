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
const mockRequestWatchRecording = vi.fn(() => Promise.resolve(true));

vi.mock("../modules/watch-motion", () => ({
  isWatchPaired: () => mockIsWatchPaired(),
  isWatchAppInstalled: () => mockIsWatchAppInstalled(),
  requestWatchRecording: () => mockRequestWatchRecording(),
}));

const mockSyncWatchAccelerometerFiles = vi.fn(() =>
  Promise.resolve({ totalInserted: 0, filesProcessed: 0, filesFailed: 0 }),
);

vi.mock("./watch-file-sync", () => ({
  syncWatchAccelerometerFiles: (...args: unknown[]) => mockSyncWatchAccelerometerFiles(...args),
}));

const mockCaptureException = vi.fn();

vi.mock("./telemetry", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
    mockSyncWatchAccelerometerFiles.mockReset();
    mockSyncWatchAccelerometerFiles.mockResolvedValue({
      totalInserted: 0,
      filesProcessed: 0,
      filesFailed: 0,
    });
    mockIsWatchPaired.mockReturnValue(true);
    mockIsWatchAppInstalled.mockReturnValue(true);
    mockRequestWatchRecording.mockReset();
    mockRequestWatchRecording.mockResolvedValue(true);
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
    expect(mockSyncWatchAccelerometerFiles).toHaveBeenCalledTimes(1);
    expect(mockSyncWatchAccelerometerFiles).toHaveBeenCalledWith(trpcClient);
  });

  it("requests Watch recording after sync", async () => {
    await initBackgroundWatchAccelerometerSync(trpcClient);

    expect(mockRequestWatchRecording).toHaveBeenCalledTimes(1);
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
    mockSyncWatchAccelerometerFiles.mockRejectedValue(syncError);

    appStateCallback?.("active");

    await vi.waitFor(() => {
      expect(mockCaptureException).toHaveBeenCalledWith(syncError, {
        source: "bg-watch-accel-sync",
      });
    });
  });

  it("resets syncing flag after error so next foreground event can sync", async () => {
    await initBackgroundWatchAccelerometerSync(trpcClient);

    mockSyncWatchAccelerometerFiles.mockRejectedValue(new Error("first failure"));
    appStateCallback?.("active");

    await vi.waitFor(() => {
      expect(mockCaptureException).toHaveBeenCalled();
    });

    mockCaptureException.mockClear();
    mockSyncWatchAccelerometerFiles.mockResolvedValue({
      totalInserted: 3,
      filesProcessed: 1,
      filesFailed: 0,
    });

    appStateCallback?.("active");

    await vi.waitFor(() => {
      // Initial sync (1) + first foreground (2) + second foreground (3)
      expect(mockSyncWatchAccelerometerFiles).toHaveBeenCalledTimes(3);
    });
  });

  it("teardown removes the AppState listener", async () => {
    await initBackgroundWatchAccelerometerSync(trpcClient);

    teardownBackgroundWatchAccelerometerSync();

    expect(mockRemove).toHaveBeenCalled();
  });
});
