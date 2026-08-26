import { AppState } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type InertialMeasurementUnitUploadClient,
  initBackgroundWhoopBleSync,
  syncWhoopBle,
  teardownBackgroundWhoopBleSync,
  type WhoopBleRealtimeUploadClient,
  type WhoopBleSyncDeps,
} from "./background-whoop-ble-sync.ts";

const { mockLoadDeviceErasureCutoff } = vi.hoisted(() => ({
  mockLoadDeviceErasureCutoff: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("./device-erasure-cutoff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./device-erasure-cutoff")>();
  return {
    ...actual,
    loadDeviceErasureCutoff: mockLoadDeviceErasureCutoff,
  };
});

function makeMockDeps(): WhoopBleSyncDeps {
  return {
    isBluetoothAvailable: vi.fn().mockReturnValue(true),
    findWhoop: vi.fn().mockResolvedValue({ id: "whoop-123", name: "WHOOP 4.0" }),
    connect: vi.fn().mockResolvedValue(true),
    startImuStreaming: vi.fn().mockResolvedValue(true),
    stopImuStreaming: vi.fn().mockResolvedValue(true),
    peekBufferedSamples: vi.fn().mockResolvedValue([]),
    confirmSamplesDrain: vi.fn(),
    peekBufferedRealtimeData: vi.fn().mockResolvedValue([]),
    confirmRealtimeDataDrain: vi.fn(),
    addConnectionStateListener: vi.fn().mockReturnValue({ remove: vi.fn() }),
    disconnect: vi.fn(),
  };
}

function makeMockTrpcClient(): InertialMeasurementUnitUploadClient {
  return {
    inertialMeasurementUnitSync: {
      pushSamples: {
        mutate: vi.fn().mockResolvedValue({ inserted: 0 }),
      },
    },
  };
}

function makeMockRealtimeClient(): WhoopBleRealtimeUploadClient {
  return {
    whoopBleSync: {
      pushRealtimeData: {
        mutate: vi.fn().mockResolvedValue({ inserted: 0 }),
      },
    },
  };
}

let appStateCallback: ((state: string) => void) | null = null;
const mockRemove = vi.fn();

vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: vi
      .fn()
      .mockImplementation((_event: string, callback: (state: string) => void) => {
        appStateCallback = callback;
        return { remove: mockRemove };
      }),
  },
}));

vi.mock("@sentry/react-native", () => ({
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock("./telemetry", () => ({
  captureException: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("background-whoop-ble-sync", () => {
  let whoopDeps: WhoopBleSyncDeps;
  let trpcClient: InertialMeasurementUnitUploadClient;

  beforeEach(() => {
    mockLoadDeviceErasureCutoff.mockResolvedValue(null);
    whoopDeps = makeMockDeps();
    trpcClient = makeMockTrpcClient();
    appStateCallback = null;
    AppState.currentState = "active";
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

  it("connects and starts streaming immediately on init", async () => {
    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    expect(whoopDeps.findWhoop).toHaveBeenCalled();
    expect(whoopDeps.connect).toHaveBeenCalledWith("whoop-123");
    expect(whoopDeps.startImuStreaming).toHaveBeenCalled();
  });

  it("waits to connect until the app foregrounds when initialized in the background", async () => {
    AppState.currentState = "background";

    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    expect(whoopDeps.findWhoop).not.toHaveBeenCalled();
    expect(whoopDeps.connect).not.toHaveBeenCalled();
    expect(whoopDeps.startImuStreaming).not.toHaveBeenCalled();

    AppState.currentState = "active";
    appStateCallback?.("active");

    await vi.waitFor(() => {
      expect(whoopDeps.connect).toHaveBeenCalledWith("whoop-123");
      expect(whoopDeps.startImuStreaming).toHaveBeenCalled();
    });
  });

  it("prevents a foreground transition from overlapping the initial sync", async () => {
    let resolveInitialDrain: (() => void) | null = null;
    vi.mocked(whoopDeps.peekBufferedSamples)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitialDrain = () => resolve([]);
          }),
      )
      .mockResolvedValue([]);

    const initPromise = initBackgroundWhoopBleSync(trpcClient, whoopDeps);
    await vi.waitFor(() => {
      expect(whoopDeps.peekBufferedSamples).toHaveBeenCalledTimes(1);
    });

    appStateCallback?.("active");

    expect(whoopDeps.peekBufferedSamples).toHaveBeenCalledTimes(1);

    resolveInitialDrain?.();
    await initPromise;
  });

  it("does not connect when the app backgrounds while searching for WHOOP", async () => {
    vi.mocked(whoopDeps.findWhoop).mockImplementation(async () => {
      AppState.currentState = "background";
      return { id: "whoop-123", name: "WHOOP 4.0" };
    });

    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    expect(whoopDeps.connect).not.toHaveBeenCalled();
    expect(whoopDeps.startImuStreaming).not.toHaveBeenCalled();
  });

  it("disconnects when the app backgrounds while connecting to WHOOP", async () => {
    vi.mocked(whoopDeps.connect).mockImplementation(async () => {
      AppState.currentState = "background";
      return true;
    });

    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    expect(whoopDeps.startImuStreaming).not.toHaveBeenCalled();
    expect(whoopDeps.disconnect).toHaveBeenCalled();
  });

  it("disconnects when the app backgrounds while starting WHOOP streaming", async () => {
    vi.mocked(whoopDeps.startImuStreaming).mockImplementation(async () => {
      AppState.currentState = "background";
      return true;
    });

    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    expect(whoopDeps.disconnect).toHaveBeenCalled();
    expect(whoopDeps.peekBufferedSamples).not.toHaveBeenCalled();
  });

  it("uploads buffered samples with gyroscope data immediately on init", async () => {
    const samples = [
      {
        timestamp: "2026-03-27T10:00:00.000Z",
        x: 1,
        y: 2,
        z: 3,
        gyroscopeX: 10,
        gyroscopeY: -20,
        gyroscopeZ: 30,
      },
    ];
    vi.mocked(whoopDeps.peekBufferedSamples).mockResolvedValueOnce(samples);

    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledWith({
      deviceId: "WHOOP Strap",
      deviceType: "whoop",
      samples: [
        {
          timestamp: "2026-03-27T10:00:00.000Z",
          x: 1,
          y: 2,
          z: 3,
          gyroscopeX: 10,
          gyroscopeY: -20,
          gyroscopeZ: 30,
        },
      ],
    });
  });

  it("requests bounded IMU batches from the native buffer", async () => {
    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    expect(whoopDeps.peekBufferedSamples).toHaveBeenCalledWith(500);
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
        x: 100,
        y: -200,
        z: 300,
        gyroscopeX: 10,
        gyroscopeY: -20,
        gyroscopeZ: 30,
      },
    ];
    vi.mocked(whoopDeps.peekBufferedSamples).mockResolvedValueOnce(samples);

    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);
    appStateCallback?.("active");

    await vi.waitFor(() => {
      expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledWith({
        deviceId: "WHOOP Strap",
        deviceType: "whoop",
        samples: expect.arrayContaining([
          expect.objectContaining({ timestamp: "2026-03-25T08:00:00.000Z" }),
        ]),
      });
    });
  });

  it("skips when findWhoop returns null (Bluetooth unavailable or no strap)", async () => {
    vi.mocked(whoopDeps.findWhoop).mockResolvedValue(null);

    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    // findWhoop was called (we no longer pre-check isBluetoothAvailable)
    expect(whoopDeps.findWhoop).toHaveBeenCalled();
    // But connect was never called since findWhoop returned null
    expect(whoopDeps.connect).not.toHaveBeenCalled();
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

    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).not.toHaveBeenCalled();
  });

  it("ignores non-active state changes", async () => {
    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);
    // Init does an initial sync, so clear call counts before testing state changes
    vi.mocked(whoopDeps.peekBufferedSamples).mockClear();

    await appStateCallback?.("background");
    await appStateCallback?.("inactive");

    // No additional sync calls from non-active state changes
    expect(whoopDeps.peekBufferedSamples).not.toHaveBeenCalled();
  });

  it("prevents concurrent syncs on foreground events", async () => {
    // Let init complete normally first
    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    // Clear counts from the initial sync
    vi.mocked(whoopDeps.peekBufferedSamples).mockClear();

    // Now make getBufferedSamples slow to simulate a long sync
    let resolveBuffered: (() => void) | null = null;
    vi.mocked(whoopDeps.peekBufferedSamples).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveBuffered = () => resolve([]);
        }),
    );

    // First foreground — starts but doesn't resolve
    appStateCallback?.("active");
    // Second foreground — should be skipped because syncing is true
    appStateCallback?.("active");

    // getBufferedSamples should only be called once for the foreground events
    // (the second call was skipped due to the syncing guard)
    await vi.waitFor(() => expect(whoopDeps.peekBufferedSamples).toHaveBeenCalledTimes(1));

    // Resolve so cleanup doesn't hang
    resolveBuffered?.();
  });

  it("teardown removes the AppState listener", async () => {
    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    teardownBackgroundWhoopBleSync();

    expect(mockRemove).toHaveBeenCalled();
  });

  it("teardown stops streaming and disconnects", async () => {
    // Init now connects immediately, no foreground event needed
    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    teardownBackgroundWhoopBleSync();

    expect(whoopDeps.stopImuStreaming).toHaveBeenCalled();
    expect(whoopDeps.disconnect).toHaveBeenCalled();
  });

  it("teardown clears the periodic drain timer", async () => {
    vi.useFakeTimers();
    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    // Clear call counts from initial sync
    vi.mocked(whoopDeps.peekBufferedSamples).mockClear();

    teardownBackgroundWhoopBleSync();

    // Advance past the drain interval — should NOT trigger a drain
    await vi.advanceTimersByTimeAsync(60_000);
    expect(whoopDeps.peekBufferedSamples).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("periodic drain uploads buffered samples every 30s", async () => {
    vi.useFakeTimers();
    const samples = [
      {
        timestamp: "2026-03-27T10:00:00.000Z",
        x: 1,
        y: 2,
        z: 3,
        gyroscopeX: 10,
        gyroscopeY: -20,
        gyroscopeZ: 30,
      },
    ];

    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    // Clear call counts from initial sync
    vi.mocked(whoopDeps.peekBufferedSamples).mockClear();
    vi.mocked(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).mockClear();

    // Set up a one-shot mock for the periodic drain
    vi.mocked(whoopDeps.peekBufferedSamples).mockResolvedValueOnce(samples);

    // Advance 30s to trigger the periodic drain
    await vi.advanceTimersByTimeAsync(30_000);

    expect(whoopDeps.peekBufferedSamples).toHaveBeenCalled();
    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledWith({
      deviceId: "WHOOP Strap",
      deviceType: "whoop",
      samples: expect.arrayContaining([
        expect.objectContaining({ timestamp: "2026-03-27T10:00:00.000Z" }),
      ]),
    });

    vi.useRealTimers();
  });

  it("skips periodic drain while the app is backgrounded", async () => {
    vi.useFakeTimers();
    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    vi.mocked(whoopDeps.peekBufferedSamples).mockClear();
    AppState.currentState = "background";

    await vi.advanceTimersByTimeAsync(30_000);

    expect(whoopDeps.peekBufferedSamples).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("stops the periodic drain timer when the app backgrounds", async () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    clearIntervalSpy.mockClear();
    vi.mocked(whoopDeps.peekBufferedSamples).mockClear();
    AppState.currentState = "background";
    appStateCallback?.("background");

    expect(clearIntervalSpy).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(whoopDeps.peekBufferedSamples).not.toHaveBeenCalled();

    clearIntervalSpy.mockRestore();
    vi.useRealTimers();
  });

  it("stops periodic drain before upload when the app backgrounds after reading samples", async () => {
    vi.useFakeTimers();
    const samples = [
      {
        timestamp: "2026-03-27T10:00:00.000Z",
        x: 1,
        y: 2,
        z: 3,
        gyroscopeX: 10,
        gyroscopeY: -20,
        gyroscopeZ: 30,
      },
    ];

    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    vi.mocked(whoopDeps.peekBufferedSamples).mockClear();
    vi.mocked(whoopDeps.peekBufferedSamples).mockImplementationOnce(async () => {
      AppState.currentState = "background";
      return samples;
    });
    vi.mocked(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).mockClear();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(whoopDeps.peekBufferedSamples).toHaveBeenCalledWith(500);
    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).not.toHaveBeenCalled();
    expect(whoopDeps.confirmSamplesDrain).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("drains buffer in multiple batches until empty", async () => {
    const batch1 = [
      {
        timestamp: "2026-03-27T10:00:00.000Z",
        x: 1,
        y: 2,
        z: 3,
        gyroscopeX: 10,
        gyroscopeY: -20,
        gyroscopeZ: 30,
      },
    ];
    const batch2 = [
      {
        timestamp: "2026-03-27T10:00:01.000Z",
        x: 4,
        y: 5,
        z: 6,
        gyroscopeX: 40,
        gyroscopeY: -50,
        gyroscopeZ: 60,
      },
    ];

    // Return batch1 on first call, batch2 on second, then empty
    vi.mocked(whoopDeps.peekBufferedSamples)
      .mockResolvedValueOnce(batch1)
      .mockResolvedValueOnce(batch2)
      .mockResolvedValueOnce([]);

    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    // Should have uploaded twice — once per batch
    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledTimes(2);
    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        samples: expect.arrayContaining([
          expect.objectContaining({ timestamp: "2026-03-27T10:00:00.000Z" }),
        ]),
      }),
    );
    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        samples: expect.arrayContaining([
          expect.objectContaining({ timestamp: "2026-03-27T10:00:01.000Z" }),
        ]),
      }),
    );
  });

  it("confirms drain after successful upload", async () => {
    const samples = [
      {
        timestamp: "2026-03-27T10:00:00.000Z",
        x: 1,
        y: 2,
        z: 3,
        gyroscopeX: 10,
        gyroscopeY: -20,
        gyroscopeZ: 30,
      },
    ];
    vi.mocked(whoopDeps.peekBufferedSamples).mockResolvedValueOnce(samples);

    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    expect(whoopDeps.confirmSamplesDrain).toHaveBeenCalledWith(1);
  });

  it("discards old-account IMU and realtime samples at the durable cutoff", async () => {
    const cutoff = "2026-03-27T10:00:00.000Z";
    mockLoadDeviceErasureCutoff.mockResolvedValue(cutoff);
    vi.mocked(whoopDeps.peekBufferedSamples).mockResolvedValueOnce([
      {
        timestamp: cutoff,
        x: 1,
        y: 2,
        z: 3,
      },
      {
        timestamp: "2026-03-27T10:00:01.000Z",
        x: 4,
        y: 5,
        z: 6,
      },
    ]);
    vi.mocked(whoopDeps.peekBufferedRealtimeData).mockResolvedValueOnce([
      {
        timestamp: cutoff,
        rrIntervalMs: 900,
        quaternionW: 1,
        quaternionX: 0,
        quaternionY: 0,
        quaternionZ: 0,
        opticalRawHex: "old",
      },
      {
        timestamp: "2026-03-27T10:00:01.000Z",
        rrIntervalMs: 800,
        quaternionW: 1,
        quaternionX: 0,
        quaternionY: 0,
        quaternionZ: 0,
        opticalRawHex: "new",
      },
    ]);
    const realtimeClient = makeMockRealtimeClient();

    await initBackgroundWhoopBleSync(trpcClient, whoopDeps, realtimeClient);

    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        samples: [expect.objectContaining({ timestamp: "2026-03-27T10:00:01.000Z" })],
      }),
    );
    expect(realtimeClient.whoopBleSync.pushRealtimeData.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        samples: [expect.objectContaining({ timestamp: "2026-03-27T10:00:01.000Z" })],
      }),
    );
    expect(whoopDeps.confirmSamplesDrain).toHaveBeenCalledWith(2);
    expect(whoopDeps.confirmRealtimeDataDrain).toHaveBeenCalledWith(2);
  });

  it("groups buffered IMU samples by captured device id before upload", async () => {
    const strapA1 = {
      deviceId: "whoop-a",
      timestamp: "2026-03-27T10:00:00.000Z",
      x: 1,
      y: 2,
      z: 3,
      gyroscopeX: 10,
      gyroscopeY: -20,
      gyroscopeZ: 30,
    };
    const strapB = {
      deviceId: "whoop-b",
      timestamp: "2026-03-27T10:00:01.000Z",
      x: 4,
      y: 5,
      z: 6,
      gyroscopeX: 40,
      gyroscopeY: -50,
      gyroscopeZ: 60,
    };
    const strapA2 = {
      deviceId: "whoop-a",
      timestamp: "2026-03-27T10:00:02.000Z",
      x: 7,
      y: 8,
      z: 9,
      gyroscopeX: 70,
      gyroscopeY: -80,
      gyroscopeZ: 90,
    };
    vi.mocked(whoopDeps.peekBufferedSamples).mockResolvedValueOnce([strapA1, strapB, strapA2]);

    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledTimes(2);
    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenNthCalledWith(1, {
      deviceId: "whoop-a",
      deviceType: "whoop",
      samples: [
        {
          timestamp: strapA1.timestamp,
          x: strapA1.x,
          y: strapA1.y,
          z: strapA1.z,
          gyroscopeX: strapA1.gyroscopeX,
          gyroscopeY: strapA1.gyroscopeY,
          gyroscopeZ: strapA1.gyroscopeZ,
        },
        {
          timestamp: strapA2.timestamp,
          x: strapA2.x,
          y: strapA2.y,
          z: strapA2.z,
          gyroscopeX: strapA2.gyroscopeX,
          gyroscopeY: strapA2.gyroscopeY,
          gyroscopeZ: strapA2.gyroscopeZ,
        },
      ],
    });
    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenNthCalledWith(2, {
      deviceId: "whoop-b",
      deviceType: "whoop",
      samples: [
        {
          timestamp: strapB.timestamp,
          x: strapB.x,
          y: strapB.y,
          z: strapB.z,
          gyroscopeX: strapB.gyroscopeX,
          gyroscopeY: strapB.gyroscopeY,
          gyroscopeZ: strapB.gyroscopeZ,
        },
      ],
    });
    expect(whoopDeps.confirmSamplesDrain).toHaveBeenCalledWith(3);
  });

  it("leaves a mixed-device IMU page buffered when one device upload fails", async () => {
    const strapA = {
      deviceId: "whoop-a",
      timestamp: "2026-03-27T10:00:00.000Z",
      x: 1,
      y: 2,
      z: 3,
      gyroscopeX: 10,
      gyroscopeY: -20,
      gyroscopeZ: 30,
    };
    const strapB = {
      deviceId: "whoop-b",
      timestamp: "2026-03-27T10:00:01.000Z",
      x: 4,
      y: 5,
      z: 6,
      gyroscopeX: 40,
      gyroscopeY: -50,
      gyroscopeZ: 60,
    };
    vi.mocked(whoopDeps.peekBufferedSamples).mockResolvedValue([strapA, strapB]);
    vi.mocked(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate)
      .mockResolvedValueOnce({ inserted: 1 })
      .mockRejectedValueOnce(new Error("network error"));

    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    expect(whoopDeps.confirmSamplesDrain).not.toHaveBeenCalled();
  });

  it("does not confirm drain when upload fails", async () => {
    const { captureException } = await import("./telemetry");
    const samples = [
      {
        timestamp: "2026-03-27T10:00:00.000Z",
        x: 1,
        y: 2,
        z: 3,
        gyroscopeX: 10,
        gyroscopeY: -20,
        gyroscopeZ: 30,
      },
    ];
    vi.mocked(whoopDeps.peekBufferedSamples).mockResolvedValue(samples);
    vi.mocked(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).mockRejectedValue(
      new Error("network error"),
    );

    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    expect(whoopDeps.confirmSamplesDrain).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      source: "whoop-ble-imu-upload",
      bufferedSampleCount: 1,
      deviceCount: 1,
      deviceIds: ["WHOOP Strap"],
      firstTimestamp: "2026-03-27T10:00:00.000Z",
      lastTimestamp: "2026-03-27T10:00:00.000Z",
    });
  });

  it("reports raw device context when IMU grouping fails before upload", async () => {
    const { captureException } = await import("./telemetry");
    const groupingError = new Error("malformed buffered sample");
    const malformedSample = {
      deviceId: "whoop-a",
      timestamp: "2026-03-27T10:00:00.000Z",
      get x() {
        throw groupingError;
      },
      y: 2,
      z: 3,
      gyroscopeX: 10,
      gyroscopeY: -20,
      gyroscopeZ: 30,
    };
    vi.mocked(whoopDeps.peekBufferedSamples).mockResolvedValue([malformedSample]);

    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).not.toHaveBeenCalled();
    expect(whoopDeps.confirmSamplesDrain).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(groupingError, {
      source: "whoop-ble-imu-upload",
      bufferedSampleCount: 1,
      deviceCount: 1,
      deviceIds: ["whoop-a"],
      firstTimestamp: "2026-03-27T10:00:00.000Z",
      lastTimestamp: "2026-03-27T10:00:00.000Z",
    });
  });

  it("resets connected on BLE disconnect event", async () => {
    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    // Get the disconnect listener callback
    const listenerCall = vi.mocked(whoopDeps.addConnectionStateListener).mock.calls[0];
    const connectionCallback = listenerCall[0];

    // Clear mocks from init
    vi.mocked(whoopDeps.findWhoop).mockClear();
    vi.mocked(whoopDeps.connect).mockClear();

    // Simulate disconnect
    connectionCallback({ state: "disconnected", error: "BLE link loss" });

    // On next foreground, should attempt reconnection
    appStateCallback?.("active");
    await vi.waitFor(() => {
      expect(whoopDeps.findWhoop).toHaveBeenCalled();
    });
    expect(whoopDeps.connect).toHaveBeenCalled();
  });

  it("does not throw when connection fails", async () => {
    vi.mocked(whoopDeps.connect).mockRejectedValue(new Error("BLE error"));

    // Init should not throw even when BLE connection fails (best-effort)
    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    expect(whoopDeps.connect).toHaveBeenCalled();
  });

  it("calls the canonical telemetry helper when foreground sync rejects", async () => {
    const { captureException } = await import("./telemetry");

    // Let init succeed normally first
    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    // Make the next sync fail (getBufferedSamples is called after connection)
    const syncError = new Error("upload failed");
    vi.mocked(whoopDeps.peekBufferedSamples).mockRejectedValue(syncError);

    // Trigger foreground event
    appStateCallback?.("active");

    await vi.waitFor(() => {
      expect(captureException).toHaveBeenCalledWith(syncError, {
        source: "whoop-ble-foreground-sync",
      });
    });
  });

  it("calls the canonical telemetry helper when init sync rejects", async () => {
    const { captureException } = await import("./telemetry");
    const initError = new Error("init BLE failure");
    vi.mocked(whoopDeps.connect).mockRejectedValue(initError);

    // Init should not throw
    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    expect(captureException).toHaveBeenCalledWith(initError, {
      source: "whoop-ble-init-sync",
    });
  });
});

describe("syncWhoopBle", () => {
  let whoopDeps: WhoopBleSyncDeps;
  let trpcClient: InertialMeasurementUnitUploadClient;

  beforeEach(() => {
    teardownBackgroundWhoopBleSync();
    AppState.currentState = "active";
    whoopDeps = makeMockDeps();
    trpcClient = makeMockTrpcClient();
  });

  afterEach(() => {
    teardownBackgroundWhoopBleSync();
  });

  it("connects and uploads buffered samples", async () => {
    const samples = [
      {
        timestamp: "2026-03-25T08:00:00.000Z",
        x: 100,
        y: -200,
        z: 300,
        gyroscopeX: 10,
        gyroscopeY: -20,
        gyroscopeZ: 30,
      },
    ];
    vi.mocked(whoopDeps.peekBufferedSamples).mockResolvedValueOnce(samples);

    await syncWhoopBle(trpcClient, whoopDeps);

    expect(whoopDeps.findWhoop).toHaveBeenCalled();
    expect(whoopDeps.connect).toHaveBeenCalledWith("whoop-123");
    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledWith({
      deviceId: "WHOOP Strap",
      deviceType: "whoop",
      samples: expect.arrayContaining([
        expect.objectContaining({ timestamp: "2026-03-25T08:00:00.000Z" }),
      ]),
    });
  });

  it("uploads buffered samples when invoked by background refresh while app is backgrounded", async () => {
    AppState.currentState = "background";
    const samples = [
      {
        timestamp: "2026-03-25T08:00:00.000Z",
        x: 100,
        y: -200,
        z: 300,
        gyroscopeX: 10,
        gyroscopeY: -20,
        gyroscopeZ: 30,
      },
    ];
    vi.mocked(whoopDeps.peekBufferedSamples).mockResolvedValueOnce(samples);

    await syncWhoopBle(trpcClient, whoopDeps);

    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledWith({
      deviceId: "WHOOP Strap",
      deviceType: "whoop",
      samples: expect.arrayContaining([
        expect.objectContaining({ timestamp: "2026-03-25T08:00:00.000Z" }),
      ]),
    });
  });

  it("skips when WHOOP not found", async () => {
    vi.mocked(whoopDeps.findWhoop).mockResolvedValue(null);

    await syncWhoopBle(trpcClient, whoopDeps);

    expect(whoopDeps.connect).not.toHaveBeenCalled();
  });

  it("reports errors through the canonical telemetry helper", async () => {
    const { captureException } = await import("./telemetry");
    const bleError = new Error("BLE error");
    vi.mocked(whoopDeps.connect).mockRejectedValue(bleError);

    await expect(syncWhoopBle(trpcClient, whoopDeps)).rejects.toBe(bleError);

    expect(captureException).toHaveBeenCalledWith(bleError, {
      source: "whoop-ble-background-refresh",
    });
  });

  it("rejects on errors so the native background task can report failure", async () => {
    const error = new Error("BLE error");
    vi.mocked(whoopDeps.connect).mockRejectedValue(error);

    await expect(syncWhoopBle(trpcClient, whoopDeps)).rejects.toBe(error);
  });
});

describe("realtime data (beat interval + quaternion) sync", () => {
  let whoopDeps: WhoopBleSyncDeps;
  let trpcClient: InertialMeasurementUnitUploadClient;
  let realtimeClient: WhoopBleRealtimeUploadClient;

  beforeEach(() => {
    teardownBackgroundWhoopBleSync();
    AppState.currentState = "active";
    whoopDeps = makeMockDeps();
    trpcClient = makeMockTrpcClient();
    realtimeClient = makeMockRealtimeClient();
  });

  afterEach(() => {
    teardownBackgroundWhoopBleSync();
  });

  it("drains realtime data buffer on init", async () => {
    const realtimeSamples = [
      {
        timestamp: "2026-03-30T12:00:00.000Z",
        heartRate: 72,
        quaternionW: 0.02,
        quaternionX: 0.68,
        quaternionY: -0.71,
        quaternionZ: 0.2,
        rrIntervalMs: 0,
        opticalRawHex: "000000000000000000000000000000000000",
      },
    ];
    vi.mocked(whoopDeps.peekBufferedRealtimeData).mockResolvedValueOnce(realtimeSamples);

    await initBackgroundWhoopBleSync(trpcClient, whoopDeps, realtimeClient);

    expect(realtimeClient.whoopBleSync.pushRealtimeData.mutate).toHaveBeenCalledWith({
      deviceId: "WHOOP Strap",
      samples: [
        {
          timestamp: "2026-03-30T12:00:00.000Z",
          quaternionW: 0.02,
          quaternionX: 0.68,
          quaternionY: -0.71,
          quaternionZ: 0.2,
          rrIntervalMs: 0,
          opticalRawHex: "000000000000000000000000000000000000",
        },
      ],
    });
  });

  it("groups buffered realtime data by captured device id before upload", async () => {
    type BufferedRealtimeSample = Awaited<
      ReturnType<WhoopBleSyncDeps["peekBufferedRealtimeData"]>
    >[number] & { deviceId: string };
    const strapA1: BufferedRealtimeSample = {
      deviceId: "whoop-a",
      timestamp: "2026-03-30T12:00:00.000Z",
      quaternionW: 0.02,
      quaternionX: 0.68,
      quaternionY: -0.71,
      quaternionZ: 0.2,
      rrIntervalMs: 0,
      opticalRawHex: "000000000000000000000000000000000000",
    };
    const strapB: BufferedRealtimeSample = {
      deviceId: "whoop-b",
      timestamp: "2026-03-30T12:00:01.000Z",
      quaternionW: 1,
      quaternionX: 0,
      quaternionY: 0,
      quaternionZ: 0,
      rrIntervalMs: 833,
      opticalRawHex: "111111111111111111111111111111111111",
    };
    const strapA2: BufferedRealtimeSample = {
      deviceId: "whoop-a",
      timestamp: "2026-03-30T12:00:02.000Z",
      quaternionW: 0,
      quaternionX: 1,
      quaternionY: 0,
      quaternionZ: 0,
      rrIntervalMs: 900,
      opticalRawHex: "222222222222222222222222222222222222",
    };
    vi.mocked(whoopDeps.peekBufferedRealtimeData)
      .mockResolvedValueOnce([strapA1, strapB, strapA2])
      .mockResolvedValue([]);

    await initBackgroundWhoopBleSync(trpcClient, whoopDeps, realtimeClient);

    expect(realtimeClient.whoopBleSync.pushRealtimeData.mutate).toHaveBeenCalledTimes(2);
    expect(realtimeClient.whoopBleSync.pushRealtimeData.mutate).toHaveBeenNthCalledWith(1, {
      deviceId: "whoop-a",
      samples: [
        {
          timestamp: strapA1.timestamp,
          quaternionW: strapA1.quaternionW,
          quaternionX: strapA1.quaternionX,
          quaternionY: strapA1.quaternionY,
          quaternionZ: strapA1.quaternionZ,
          rrIntervalMs: strapA1.rrIntervalMs,
          opticalRawHex: strapA1.opticalRawHex,
        },
        {
          timestamp: strapA2.timestamp,
          quaternionW: strapA2.quaternionW,
          quaternionX: strapA2.quaternionX,
          quaternionY: strapA2.quaternionY,
          quaternionZ: strapA2.quaternionZ,
          rrIntervalMs: strapA2.rrIntervalMs,
          opticalRawHex: strapA2.opticalRawHex,
        },
      ],
    });
    expect(realtimeClient.whoopBleSync.pushRealtimeData.mutate).toHaveBeenNthCalledWith(2, {
      deviceId: "whoop-b",
      samples: [
        {
          timestamp: strapB.timestamp,
          quaternionW: strapB.quaternionW,
          quaternionX: strapB.quaternionX,
          quaternionY: strapB.quaternionY,
          quaternionZ: strapB.quaternionZ,
          rrIntervalMs: strapB.rrIntervalMs,
          opticalRawHex: strapB.opticalRawHex,
        },
      ],
    });
    expect(whoopDeps.confirmRealtimeDataDrain).toHaveBeenCalledWith(3);
  });

  it("uses the fallback device id for blank native realtime device ids", async () => {
    vi.mocked(whoopDeps.peekBufferedRealtimeData)
      .mockResolvedValueOnce([
        {
          deviceId: "  ",
          timestamp: "2026-03-30T12:00:00.000Z",
          quaternionW: 1,
          quaternionX: 0,
          quaternionY: 0,
          quaternionZ: 0,
          rrIntervalMs: 833,
          opticalRawHex: "111111111111111111111111111111111111",
        },
      ])
      .mockResolvedValue([]);

    await initBackgroundWhoopBleSync(trpcClient, whoopDeps, realtimeClient);

    expect(realtimeClient.whoopBleSync.pushRealtimeData.mutate).toHaveBeenCalledWith({
      deviceId: "WHOOP Strap",
      samples: [
        {
          timestamp: "2026-03-30T12:00:00.000Z",
          quaternionW: 1,
          quaternionX: 0,
          quaternionY: 0,
          quaternionZ: 0,
          rrIntervalMs: 833,
          opticalRawHex: "111111111111111111111111111111111111",
        },
      ],
    });
  });

  it("requests bounded realtime batches from the native buffer", async () => {
    await initBackgroundWhoopBleSync(trpcClient, whoopDeps, realtimeClient);

    expect(whoopDeps.peekBufferedRealtimeData).toHaveBeenCalledWith(500);
  });

  it("uploads only stored realtime fields and omits device heart rate", async () => {
    const realtimeSamples = [
      {
        timestamp: "2026-03-30T12:00:00.000Z",
        heartRate: 72,
        quaternionW: 0,
        quaternionX: 0,
        quaternionY: 0,
        quaternionZ: 0,
        rrIntervalMs: 833,
        opticalRawHex: "000000000000000000000000000000000000",
      },
    ];
    vi.mocked(whoopDeps.peekBufferedRealtimeData).mockResolvedValueOnce(realtimeSamples);

    await initBackgroundWhoopBleSync(trpcClient, whoopDeps, realtimeClient);

    expect(realtimeClient.whoopBleSync.pushRealtimeData.mutate).toHaveBeenCalledWith({
      deviceId: "WHOOP Strap",
      samples: [
        {
          timestamp: "2026-03-30T12:00:00.000Z",
          quaternionW: 0,
          quaternionX: 0,
          quaternionY: 0,
          quaternionZ: 0,
          rrIntervalMs: 833,
          opticalRawHex: "000000000000000000000000000000000000",
        },
      ],
    });
  });

  it("does not call realtime upload when no realtime client is provided", async () => {
    const realtimeSamples = [
      {
        timestamp: "2026-03-30T12:00:00.000Z",
        heartRate: 72,
        quaternionW: 0.0,
        quaternionX: 0.0,
        quaternionY: 0.0,
        quaternionZ: 0.0,
        rrIntervalMs: 0,
        opticalRawHex: "000000000000000000000000000000000000",
      },
    ];
    vi.mocked(whoopDeps.peekBufferedRealtimeData).mockResolvedValueOnce(realtimeSamples);

    // No realtime client provided
    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);

    // getBufferedRealtimeData should not be called since there's no client to upload to
    expect(whoopDeps.peekBufferedRealtimeData).not.toHaveBeenCalled();
  });

  it("drains both IMU and realtime buffers independently", async () => {
    const imuSamples = [
      {
        timestamp: "2026-03-30T12:00:00.000Z",
        x: 100,
        y: -200,
        z: 4096,
        gyroscopeX: 10,
        gyroscopeY: -20,
        gyroscopeZ: 30,
      },
    ];
    const realtimeSamples = [
      {
        timestamp: "2026-03-30T12:00:00.500Z",
        heartRate: 75,
        quaternionW: 0.5,
        quaternionX: 0.5,
        quaternionY: 0.5,
        quaternionZ: 0.5,
        rrIntervalMs: 0,
        opticalRawHex: "000000000000000000000000000000000000",
      },
    ];

    vi.mocked(whoopDeps.peekBufferedSamples).mockResolvedValueOnce(imuSamples);
    vi.mocked(whoopDeps.peekBufferedRealtimeData).mockResolvedValueOnce(realtimeSamples);

    await initBackgroundWhoopBleSync(trpcClient, whoopDeps, realtimeClient);

    // Both should be uploaded
    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalled();
    expect(realtimeClient.whoopBleSync.pushRealtimeData.mutate).toHaveBeenCalledWith({
      deviceId: "WHOOP Strap",
      samples: [
        {
          timestamp: "2026-03-30T12:00:00.500Z",
          quaternionW: 0.5,
          quaternionX: 0.5,
          quaternionY: 0.5,
          quaternionZ: 0.5,
          rrIntervalMs: 0,
          opticalRawHex: "000000000000000000000000000000000000",
        },
      ],
    });
  });

  it("realtime error does not prevent IMU upload", async () => {
    const imuSamples = [
      {
        timestamp: "2026-03-30T12:00:00.000Z",
        x: 1,
        y: 2,
        z: 3,
        gyroscopeX: 0,
        gyroscopeY: 0,
        gyroscopeZ: 0,
      },
    ];
    vi.mocked(whoopDeps.peekBufferedSamples).mockResolvedValueOnce(imuSamples);
    vi.mocked(whoopDeps.peekBufferedRealtimeData).mockRejectedValue(
      new Error("realtime buffer error"),
    );

    // Should not throw — errors are caught at the outer level
    await initBackgroundWhoopBleSync(trpcClient, whoopDeps, realtimeClient);

    // IMU should still have been uploaded before the realtime error
    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalled();
  });

  it("syncWhoopBle passes realtime client through", async () => {
    const realtimeSamples = [
      {
        timestamp: "2026-03-30T12:00:00.000Z",
        heartRate: 80,
        quaternionW: 1.0,
        quaternionX: 0.0,
        quaternionY: 0.0,
        quaternionZ: 0.0,
        rrIntervalMs: 0,
        opticalRawHex: "000000000000000000000000000000000000",
      },
    ];
    vi.mocked(whoopDeps.peekBufferedRealtimeData).mockResolvedValueOnce(realtimeSamples);

    await syncWhoopBle(trpcClient, whoopDeps, realtimeClient);

    expect(realtimeClient.whoopBleSync.pushRealtimeData.mutate).toHaveBeenCalledWith({
      deviceId: "WHOOP Strap",
      samples: [
        {
          timestamp: "2026-03-30T12:00:00.000Z",
          quaternionW: 1.0,
          quaternionX: 0.0,
          quaternionY: 0.0,
          quaternionZ: 0.0,
          rrIntervalMs: 0,
          opticalRawHex: "000000000000000000000000000000000000",
        },
      ],
    });
  });
});
