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
import { makeMockDeps, makeMockRealtimeClient, makeMockTrpcClient } from "./whoop-ble-test-helpers";

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
        telemetry: expect.objectContaining({ batchId: expect.any(String) }),
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

  it("disconnects a native-restored connection without a JS connection attempt", async () => {
    AppState.currentState = "background";
    await initBackgroundWhoopBleSync(trpcClient, whoopDeps);
    const listener = vi.mocked(whoopDeps.addConnectionStateListener).mock.calls[0]?.[0];
    listener?.({ state: "connected", peripheralId: "whoop-123" });
    teardownBackgroundWhoopBleSync();
    expect(whoopDeps.connect).not.toHaveBeenCalled();
    expect(whoopDeps.disconnect).toHaveBeenCalledTimes(1);
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

  it("uploads with a new client while a retired session request remains pending", async () => {
    const samples = [{ timestamp: "2026-03-27T10:00:00.000Z", x: 1, y: 2, z: 3 }];
    const buffer = [...samples];
    let releaseOldUpload: (() => void) | undefined;
    vi.mocked(whoopDeps.peekBufferedSamples).mockImplementation(async () => [...buffer]);
    vi.mocked(whoopDeps.confirmSamplesDrain).mockImplementation((count) => {
      buffer.splice(0, count);
    });
    vi.mocked(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseOldUpload = () => resolve({ inserted: 1 });
        }),
    );
    const oldInitialization = initBackgroundWhoopBleSync(trpcClient, whoopDeps);
    await vi.waitFor(() => expect(releaseOldUpload).toBeDefined());
    teardownBackgroundWhoopBleSync();

    const nextClient = makeMockTrpcClient();
    const nextInitialization = initBackgroundWhoopBleSync(nextClient, whoopDeps);
    try {
      await vi.waitFor(() => {
        expect(nextClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledWith(
          expect.objectContaining({ samples: expect.arrayContaining(samples) }),
        );
        expect(buffer).toHaveLength(0);
      });
      expect(whoopDeps.confirmSamplesDrain).toHaveBeenCalledWith(0);
    } finally {
      releaseOldUpload?.();
      await Promise.all([oldInitialization, nextInitialization]);
    }
    expect(
      vi.mocked(whoopDeps.confirmSamplesDrain).mock.calls.filter(([count]) => count > 0),
    ).toEqual([[1]]);
    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledTimes(1);
  });

  it("waits for a retired native peek and releases its cursor before the next session peeks", async () => {
    let releaseOldPeek: (() => void) | undefined;
    vi.mocked(whoopDeps.peekBufferedSamples).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseOldPeek = () =>
            resolve([{ timestamp: "2026-03-27T10:00:00.000Z", x: 1, y: 2, z: 3 }]);
        }),
    );
    const oldInitialization = initBackgroundWhoopBleSync(trpcClient, whoopDeps);
    await vi.waitFor(() => expect(releaseOldPeek).toBeDefined());
    teardownBackgroundWhoopBleSync();

    const nextClient = makeMockTrpcClient();
    const nextInitialization = initBackgroundWhoopBleSync(nextClient, whoopDeps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(whoopDeps.peekBufferedSamples).toHaveBeenCalledTimes(1);
    releaseOldPeek?.();
    await Promise.all([oldInitialization, nextInitialization]);

    expect(whoopDeps.confirmSamplesDrain).toHaveBeenCalledWith(0);
    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).not.toHaveBeenCalled();
    const releaseOrder = vi.mocked(whoopDeps.confirmSamplesDrain).mock.invocationCallOrder[0];
    const nextPeekOrder = vi.mocked(whoopDeps.peekBufferedSamples).mock.invocationCallOrder[1];
    expect(releaseOrder).toBeLessThan(nextPeekOrder ?? 0);
  });

  it("releases a rejected retired peek before allowing a new session to drain", async () => {
    const { captureException } = await import("./telemetry");
    const error = new Error("old native peek rejected");
    let rejectPeek: (() => void) | undefined;
    vi.mocked(whoopDeps.peekBufferedSamples).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectPeek = () => reject(error);
        }),
    );
    const oldInitialization = initBackgroundWhoopBleSync(trpcClient, whoopDeps);
    await vi.waitFor(() => expect(rejectPeek).toBeDefined());
    teardownBackgroundWhoopBleSync();
    const nextInitialization = initBackgroundWhoopBleSync(makeMockTrpcClient(), whoopDeps);
    rejectPeek?.();
    await Promise.all([oldInitialization, nextInitialization]);
    expect(whoopDeps.peekBufferedSamples).toHaveBeenCalledTimes(2);
    expect(whoopDeps.confirmSamplesDrain).toHaveBeenCalledWith(0);
    expect(captureException).toHaveBeenCalledWith(error, {
      source: "whoop-ble-init-sync",
      retiredLifetime: true,
    });
  });

  it("does not disconnect the next session when a retired connection finishes", async () => {
    let resolveConnect: (() => void) | undefined;
    vi.mocked(whoopDeps.connect).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveConnect = () => resolve(true);
        }),
    );
    const oldInitialization = initBackgroundWhoopBleSync(trpcClient, whoopDeps);
    await vi.waitFor(() => expect(resolveConnect).toBeDefined());
    teardownBackgroundWhoopBleSync();
    expect(whoopDeps.disconnect).toHaveBeenCalledTimes(1);
    const nextDeps = makeMockDeps();
    await initBackgroundWhoopBleSync(makeMockTrpcClient(), nextDeps);
    resolveConnect?.();
    await oldInitialization;
    expect(whoopDeps.startImuStreaming).not.toHaveBeenCalled();
    expect(whoopDeps.disconnect).toHaveBeenCalledTimes(1);
    expect(nextDeps.disconnect).not.toHaveBeenCalled();
    expect(nextDeps.startImuStreaming).toHaveBeenCalledTimes(1);
  });

  it("cancels connection intent while retired streaming startup is pending", async () => {
    let finishStreaming: (() => void) | undefined;
    vi.mocked(whoopDeps.startImuStreaming).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishStreaming = () => resolve(true);
        }),
    );
    const oldInitialization = initBackgroundWhoopBleSync(trpcClient, whoopDeps);
    await vi.waitFor(() => expect(finishStreaming).toBeDefined());
    teardownBackgroundWhoopBleSync();
    expect(whoopDeps.disconnect).toHaveBeenCalledTimes(1);
    const nextDeps = makeMockDeps();
    await initBackgroundWhoopBleSync(makeMockTrpcClient(), nextDeps);
    finishStreaming?.();
    await oldInitialization;
    expect(whoopDeps.peekBufferedSamples).not.toHaveBeenCalled();
    expect(whoopDeps.disconnect).toHaveBeenCalledTimes(1);
    expect(nextDeps.disconnect).not.toHaveBeenCalled();
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
      telemetry: expect.objectContaining({ batchId: expect.any(String) }),
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
    expect(
      vi.mocked(whoopDeps.confirmSamplesDrain).mock.calls.filter(([count]) => count > 0),
    ).toEqual([]);

    vi.useRealTimers();
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
      telemetry: expect.objectContaining({ batchId: expect.any(String) }),
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
      telemetry: expect.objectContaining({ batchId: expect.any(String) }),
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

  it("uploads buffered samples and does not report when the connect handshake times out", async () => {
    const { captureException } = await import("./telemetry");
    vi.mocked(captureException).mockClear();
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
    vi.mocked(whoopDeps.connect).mockRejectedValue(
      Object.assign(new Error("TIMEOUT: undefined reason"), { code: "TIMEOUT" }),
    );

    await expect(syncWhoopBle(trpcClient, whoopDeps)).resolves.toBeUndefined();

    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledWith({
      telemetry: expect.objectContaining({ batchId: expect.any(String) }),
      deviceId: "WHOOP Strap",
      deviceType: "whoop",
      samples: expect.arrayContaining([
        expect.objectContaining({ timestamp: "2026-03-25T08:00:00.000Z" }),
      ]),
    });
    expect(captureException).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source: "whoop-ble-background-refresh" }),
    );
  });

  it("still reports and rejects non-timeout connect errors", async () => {
    const { captureException } = await import("./telemetry");
    vi.mocked(captureException).mockClear();
    const deviceNotFoundError = Object.assign(new Error("Peripheral not found"), {
      code: "NOT_FOUND",
    });
    vi.mocked(whoopDeps.connect).mockRejectedValue(deviceNotFoundError);

    await expect(syncWhoopBle(trpcClient, whoopDeps)).rejects.toBe(deviceNotFoundError);

    expect(captureException).toHaveBeenCalledWith(deviceNotFoundError, {
      source: "whoop-ble-background-refresh",
    });
    expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).not.toHaveBeenCalled();
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
    mockLoadDeviceErasureCutoff.mockResolvedValue(null);
    teardownBackgroundWhoopBleSync();
    AppState.currentState = "active";
    whoopDeps = makeMockDeps();
    trpcClient = makeMockTrpcClient();
    realtimeClient = makeMockRealtimeClient();
  });

  afterEach(() => {
    teardownBackgroundWhoopBleSync();
  });

  it("does not call realtime upload when no realtime client is provided", async () => {
    const realtimeSamples = [
      {
        timestamp: "2026-03-30T12:00:00.000Z",
        heartRateBpm: 72,
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

  it("uploads new realtime samples on a periodic tick while motion is still draining", async () => {
    const { logger } = await import("./telemetry");
    vi.useFakeTimers();
    let releaseMotion: (() => void) | undefined;
    const motionGate = new Promise<void>((resolve) => {
      releaseMotion = resolve;
    });
    const realtimeSample = {
      timestamp: "2026-03-30T12:00:00.000Z",
      heartRateBpm: 75,
      rrIntervalMs: 800,
      quaternionW: 1,
      quaternionX: 0,
      quaternionY: 0,
      quaternionZ: 0,
      opticalRawHex: "000000000000000000000000000000000000",
    };
    const realtimeBuffer: Array<typeof realtimeSample> = [];
    const uploadedRealtime: number[] = [];
    vi.mocked(whoopDeps.peekBufferedSamples).mockResolvedValueOnce([
      {
        timestamp: "2026-03-30T12:00:00.000Z",
        x: 1,
        y: 2,
        z: 3,
        gyroscopeX: 0,
        gyroscopeY: 0,
        gyroscopeZ: 0,
      },
    ]);
    vi.mocked(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).mockImplementation(
      async () => {
        await motionGate;
        return { inserted: 1 };
      },
    );
    vi.mocked(whoopDeps.peekBufferedRealtimeData).mockImplementation(async () =>
      realtimeBuffer.slice(),
    );
    vi.mocked(whoopDeps.confirmRealtimeDataDrain).mockImplementation((count) => {
      realtimeBuffer.splice(0, count);
    });
    vi.mocked(realtimeClient.whoopBleSync.pushRealtimeData.mutate).mockImplementation(
      async ({ samples }) => {
        uploadedRealtime.push(...samples.map((sample) => sample.heartRateBpm));
        return { inserted: samples.length };
      },
    );
    const initialization = initBackgroundWhoopBleSync(trpcClient, whoopDeps, realtimeClient);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledTimes(1);
      expect(whoopDeps.peekBufferedRealtimeData).toHaveBeenCalledTimes(1);
      realtimeBuffer.push(realtimeSample);

      await vi.advanceTimersByTimeAsync(30_000);

      expect(logger.info).toHaveBeenCalledWith(
        "whoop-ble",
        "capture_snapshot",
        expect.objectContaining({
          trigger: "periodic",
          imuRequestPending: true,
          imuPendingRequestAgeMs: 30_000,
          imuPendingBatchId: expect.any(String),
        }),
      );
      expect(uploadedRealtime).toEqual([75]);
      expect(realtimeBuffer).toHaveLength(0);
      expect(
        vi.mocked(whoopDeps.confirmSamplesDrain).mock.calls.filter(([count]) => count > 0),
      ).toEqual([]);
      expect(trpcClient.inertialMeasurementUnitSync.pushSamples.mutate).toHaveBeenCalledTimes(1);
    } finally {
      releaseMotion?.();
      await initialization;
      vi.useRealTimers();
    }
  });

  it("syncWhoopBle passes realtime client through", async () => {
    const realtimeSamples = [
      {
        timestamp: "2026-03-30T12:00:00.000Z",
        heartRateBpm: 80,
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
      telemetry: expect.objectContaining({ batchId: expect.any(String) }),
      deviceId: "WHOOP Strap",
      samples: [
        {
          timestamp: "2026-03-30T12:00:00.000Z",
          heartRateBpm: 80,
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
