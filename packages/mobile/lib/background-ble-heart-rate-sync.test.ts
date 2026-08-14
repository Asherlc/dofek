import { AppState } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BleHeartRateSyncDeps,
  type BleHeartRateUploadClient,
  connectBleHeartRateMonitor,
  getBleHeartRateSyncState,
  initBackgroundBleHeartRateSync,
  syncBleHeartRate,
  teardownBackgroundBleHeartRateSync,
} from "./background-ble-heart-rate-sync.ts";

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

vi.mock("./telemetry", () => ({
  captureException: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

let appStateCallback: ((state: string) => void) | null = null;
let connectionStateCallback:
  | ((event: { state: string; peripheralId?: string; name?: string; error?: string }) => void)
  | null = null;
let heartRateCallback:
  | ((event: { timestamp: string; heartRateBpm: number; rrIntervalsMs: number[] }) => void)
  | null = null;
const mockAppStateRemove = vi.fn();
const mockConnectionRemove = vi.fn();
const mockHeartRateRemove = vi.fn();

vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: vi
      .fn()
      .mockImplementation((_event: string, callback: (state: string) => void) => {
        appStateCallback = callback;
        return { remove: mockAppStateRemove };
      }),
  },
}));

function makeDeps(): BleHeartRateSyncDeps {
  return {
    isBluetoothAvailable: vi.fn().mockReturnValue(true),
    scanAndConnect: vi.fn().mockResolvedValue({ id: "polar-123", name: "Polar H10" }),
    peekBufferedSamples: vi.fn().mockResolvedValue([]),
    confirmSamplesDrain: vi.fn(),
    addConnectionStateListener: vi.fn().mockImplementation((callback) => {
      connectionStateCallback = callback;
      return { remove: mockConnectionRemove };
    }),
    addHeartRateListener: vi.fn().mockImplementation((callback) => {
      heartRateCallback = callback;
      return { remove: mockHeartRateRemove };
    }),
    disconnect: vi.fn(),
  };
}

function makeUploadClient(): BleHeartRateUploadClient {
  return {
    bleHeartRateSync: {
      pushSamples: {
        mutate: vi.fn().mockResolvedValue({ inserted: 0 }),
      },
    },
  };
}

describe("background BLE heart-rate sync", () => {
  let deps: BleHeartRateSyncDeps;
  let uploadClient: BleHeartRateUploadClient;

  beforeEach(() => {
    vi.useFakeTimers();
    mockLoadDeviceErasureCutoff.mockResolvedValue(null);
    AppState.currentState = "active";
    appStateCallback = null;
    connectionStateCallback = null;
    heartRateCallback = null;
    deps = makeDeps();
    uploadClient = makeUploadClient();
    teardownBackgroundBleHeartRateSync();
    vi.clearAllMocks();
  });

  afterEach(() => {
    teardownBackgroundBleHeartRateSync();
    vi.useRealTimers();
  });

  it("uploads buffered samples independently of an activity recording", async () => {
    vi.mocked(deps.peekBufferedSamples)
      .mockResolvedValueOnce([
        {
          deviceId: "polar-123",
          timestamp: "2026-08-13T12:00:00.000Z",
          heartRateBpm: 142,
          rrIntervalsMs: [811, 820],
        },
      ])
      .mockResolvedValueOnce([]);

    await initBackgroundBleHeartRateSync(uploadClient, deps);

    expect(uploadClient.bleHeartRateSync.pushSamples.mutate).toHaveBeenCalledWith({
      deviceId: "polar-123",
      samples: [
        {
          timestamp: "2026-08-13T12:00:00.000Z",
          heartRateBpm: 142,
          rrIntervalsMs: [811, 820],
        },
      ],
    });
    expect(deps.confirmSamplesDrain).toHaveBeenCalledWith(1);
  });

  it("retains the native buffer when an upload fails", async () => {
    const uploadError = new Error("network unavailable");
    vi.mocked(deps.peekBufferedSamples).mockResolvedValueOnce([
      {
        deviceId: "polar-123",
        timestamp: "2026-08-13T12:00:00.000Z",
        heartRateBpm: 142,
        rrIntervalsMs: [],
      },
    ]);
    vi.mocked(uploadClient.bleHeartRateSync.pushSamples.mutate).mockRejectedValueOnce(uploadError);

    await expect(syncBleHeartRate(uploadClient, deps)).rejects.toThrow("network unavailable");

    expect(deps.confirmSamplesDrain).not.toHaveBeenCalled();
  });

  it("connects a monitor on demand and publishes live measurements", async () => {
    await initBackgroundBleHeartRateSync(uploadClient, deps);

    await connectBleHeartRateMonitor();
    heartRateCallback?.({
      timestamp: "2026-08-13T12:00:00.000Z",
      heartRateBpm: 137,
      rrIntervalsMs: [876],
    });

    expect(deps.scanAndConnect).toHaveBeenCalledOnce();
    expect(getBleHeartRateSyncState()).toEqual({
      bluetoothAvailable: true,
      connectionState: "connected",
      device: { id: "polar-123", name: "Polar H10" },
      liveBpm: 137,
    });
  });

  it("uploads buffered samples when the authenticated app returns to foreground", async () => {
    AppState.currentState = "background";
    await initBackgroundBleHeartRateSync(uploadClient, deps);
    vi.mocked(deps.peekBufferedSamples).mockClear();

    AppState.currentState = "active";
    appStateCallback?.("active");

    await vi.waitFor(() => expect(deps.peekBufferedSamples).toHaveBeenCalled());
  });

  it("does not let a completed prior-session drain unlock the current session", async () => {
    const priorDeps = makeDeps();
    const priorClient = makeUploadClient();
    let finishPriorDrain: (() => void) | null = null;
    vi.mocked(priorDeps.peekBufferedSamples).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPriorDrain = () => resolve([]);
        }),
    );

    const priorInit = initBackgroundBleHeartRateSync(priorClient, priorDeps);
    await vi.waitFor(() => expect(priorDeps.peekBufferedSamples).toHaveBeenCalledOnce());
    teardownBackgroundBleHeartRateSync();

    let finishCurrentDrain: (() => void) | null = null;
    vi.mocked(deps.peekBufferedSamples)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishCurrentDrain = () => resolve([]);
          }),
      )
      .mockResolvedValue([]);
    const currentInit = initBackgroundBleHeartRateSync(uploadClient, deps);
    await vi.waitFor(() => expect(deps.peekBufferedSamples).toHaveBeenCalledOnce());

    finishPriorDrain?.();
    await priorInit;
    const overlappingSync = syncBleHeartRate(uploadClient, deps);
    await Promise.resolve();

    expect(deps.peekBufferedSamples).toHaveBeenCalledOnce();

    finishCurrentDrain?.();
    await Promise.all([currentInit, overlappingSync]);
  });

  it("removes listeners and disconnects during authenticated-service teardown", async () => {
    await initBackgroundBleHeartRateSync(uploadClient, deps);
    connectionStateCallback?.({
      state: "connected",
      peripheralId: "polar-123",
      name: "Polar H10",
    });

    teardownBackgroundBleHeartRateSync();

    expect(mockAppStateRemove).toHaveBeenCalledOnce();
    expect(mockConnectionRemove).toHaveBeenCalledOnce();
    expect(mockHeartRateRemove).toHaveBeenCalledOnce();
    expect(deps.disconnect).toHaveBeenCalledOnce();
  });
});
