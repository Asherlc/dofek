import { AppState } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccelerometerUploadClient } from "./accelerometer-service.ts";
import {
  initBackgroundWhoopBleSync,
  teardownBackgroundWhoopBleSync,
  type WhoopBleSyncDeps,
} from "./background-whoop-ble-sync.ts";

function makeMockDeps(): WhoopBleSyncDeps {
  return {
    isBluetoothAvailable: vi.fn().mockReturnValue(true),
    findWhoop: vi.fn().mockResolvedValue({ id: "whoop-123", name: "WHOOP 4.0" }),
    connect: vi.fn().mockResolvedValue(true),
    startImuStreaming: vi.fn().mockResolvedValue(true),
    stopImuStreaming: vi.fn().mockResolvedValue(true),
    getBufferedSamples: vi.fn().mockResolvedValue([]),
    disconnect: vi.fn(),
  };
}

function makeMockTrpcClient(): AccelerometerUploadClient {
  return {
    accelerometerSync: {
      pushAccelerometerSamples: {
        mutate: vi.fn().mockResolvedValue({ inserted: 0 }),
      },
    },
  };
}

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

describe("background-whoop-ble-sync", () => {
  let whoopDeps: WhoopBleSyncDeps;
  let trpcClient: AccelerometerUploadClient;

  beforeEach(() => {
    whoopDeps = makeMockDeps();
    trpcClient = makeMockTrpcClient();
    appStateCallback = null;
    mockRemove.mockClear();
    vi.mocked(AppState.addEventListener).mockClear();
    teardownBackgroundWhoopBleSync();
  });

  afterEach(() => {
    teardownBackgroundWhoopBleSync();
  });

  it("registers an AppState listener on init", async () => {
    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    expect(AppState.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("connects to WHOOP and starts streaming on first foreground", async () => {
    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);
    appStateCallback?.("active");

    await vi.waitFor(() => {
      expect(whoopDeps.startImuStreaming).toHaveBeenCalled();
    });
    expect(whoopDeps.findWhoop).toHaveBeenCalled();
    expect(whoopDeps.connect).toHaveBeenCalledWith("whoop-123");
  });

  it("uploads buffered samples on foreground", async () => {
    const samples = [
      {
        timestamp: "2026-03-25T08:00:00.000Z",
        accelerometerX: 100,
        accelerometerY: -200,
        accelerometerZ: 300,
        gyroscopeX: 10,
        gyroscopeY: -20,
        gyroscopeZ: 30,
      },
    ];
    vi.mocked(whoopDeps.getBufferedSamples).mockResolvedValue(samples);

    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);
    appStateCallback?.("active");

    await vi.waitFor(() => {
      expect(trpcClient.accelerometerSync.pushAccelerometerSamples.mutate).toHaveBeenCalledWith({
        deviceId: "WHOOP Strap",
        deviceType: "whoop",
        samples: expect.arrayContaining([
          expect.objectContaining({ timestamp: "2026-03-25T08:00:00.000Z" }),
        ]),
      });
    });
  });

  it("skips when Bluetooth is unavailable", async () => {
    vi.mocked(whoopDeps.isBluetoothAvailable).mockReturnValue(false);

    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);
    await appStateCallback?.("active");

    expect(whoopDeps.findWhoop).not.toHaveBeenCalled();
  });

  it("skips when WHOOP not found", async () => {
    vi.mocked(whoopDeps.findWhoop).mockResolvedValue(null);

    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);
    await appStateCallback?.("active");

    expect(whoopDeps.connect).not.toHaveBeenCalled();
  });

  it("does not upload when buffer is empty", async () => {
    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);
    await appStateCallback?.("active");

    expect(trpcClient.accelerometerSync.pushAccelerometerSamples.mutate).not.toHaveBeenCalled();
  });

  it("ignores non-active state changes", async () => {
    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);
    await appStateCallback?.("background");
    await appStateCallback?.("inactive");

    expect(whoopDeps.findWhoop).not.toHaveBeenCalled();
  });

  it("prevents concurrent syncs", async () => {
    // Make findWhoop slow
    let resolveFind: ((value: { id: string; name: string }) => void) | null = null;
    vi.mocked(whoopDeps.findWhoop).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFind = resolve;
        }),
    );

    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    // First foreground — starts but doesn't resolve
    const firstSync = appStateCallback?.("active");
    // Second foreground — should be skipped
    await appStateCallback?.("active");

    // findWhoop should only be called once (second was skipped)
    expect(whoopDeps.findWhoop).toHaveBeenCalledTimes(1);

    // Resolve the first one
    resolveFind?.({ id: "whoop-123", name: "WHOOP 4.0" });
    await firstSync;
  });

  it("teardown removes the AppState listener", async () => {
    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    teardownBackgroundWhoopBleSync();

    expect(mockRemove).toHaveBeenCalled();
  });

  it("teardown stops streaming and disconnects", async () => {
    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);
    // Simulate a foreground to establish connection
    await appStateCallback?.("active");

    teardownBackgroundWhoopBleSync();

    expect(whoopDeps.stopImuStreaming).toHaveBeenCalled();
    expect(whoopDeps.disconnect).toHaveBeenCalled();
  });

  it("does not throw when connection fails", async () => {
    vi.mocked(whoopDeps.connect).mockRejectedValue(new Error("BLE error"));

    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);
    appStateCallback?.("active");

    // Wait for the async sync to complete
    await vi.waitFor(() => {
      expect(whoopDeps.connect).toHaveBeenCalled();
    });
    // No throw — best-effort
  });
});
