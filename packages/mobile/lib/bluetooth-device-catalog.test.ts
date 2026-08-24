import * as Sentry from "@sentry/react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockHeartRate = vi.hoisted(() => {
  let listener: ((snapshot: unknown) => void) | undefined;
  const remove = vi.fn();

  return {
    addDeviceStateListener: vi.fn((callback: (snapshot: unknown) => void) => {
      listener = callback;
      return { remove };
    }),
    emitDeviceStateChanged(snapshot: unknown) {
      listener?.(snapshot);
    },
    getDevices: vi.fn(),
    remove,
    reset() {
      listener = undefined;
      remove.mockReset();
      this.addDeviceStateListener.mockClear();
      this.getDevices.mockReset();
    },
  };
});

const mockWhoop = vi.hoisted(() => {
  let listener: ((event: unknown) => void) | undefined;
  const remove = vi.fn();

  return {
    addConnectionStateListener: vi.fn((callback: (event: unknown) => void) => {
      listener = callback;
      return { remove };
    }),
    emitConnectionStateChanged(event: unknown) {
      listener?.(event);
    },
    getDeviceSummary: vi.fn(),
    remove,
    reset() {
      listener = undefined;
      remove.mockReset();
      this.addConnectionStateListener.mockClear();
      this.getDeviceSummary.mockReset();
    },
  };
});

vi.mock("../modules/ble-heart-rate", () => mockHeartRate);
vi.mock("../modules/whoop-ble", () => mockWhoop);

const polar = {
  id: "polar",
  name: "Polar H10",
  connectionState: "ready",
  lastMeasurementAt: "2026-08-24T19:00:00.000Z",
  lastHeartRateBpm: 61,
  lastRrIntervalsMs: [984],
  bufferedSampleCount: 2,
};

const wahoo = {
  id: "wahoo",
  name: "Wahoo TICKR",
  connectionState: "disconnected",
  lastMeasurementAt: null,
  lastHeartRateBpm: null,
  lastRrIntervalsMs: [],
  bufferedSampleCount: 0,
};

describe("bluetooth-device-catalog", () => {
  beforeEach(() => {
    mockHeartRate.reset();
    mockWhoop.reset();
    mockHeartRate.getDevices.mockResolvedValue([]);
    mockWhoop.getDeviceSummary.mockReturnValue({
      id: null,
      name: null,
      connectionState: "idle",
      imuBufferedSamples: 0,
      realtimeBufferedSamples: 0,
    });
  });

  it("lists WHOOP before every persisted heart-rate monitor", async () => {
    mockHeartRate.getDevices.mockResolvedValue([polar, wahoo]);
    mockWhoop.getDeviceSummary.mockReturnValue({
      id: null,
      name: null,
      connectionState: "ready",
      imuBufferedSamples: 12,
      realtimeBufferedSamples: 4,
    });

    const { getBluetoothDevices } = await import("./bluetooth-device-catalog.ts");

    await expect(getBluetoothDevices()).resolves.toEqual([
      {
        id: "whoop",
        kind: "whoop",
        name: "WHOOP",
        peripheralId: null,
        connectionState: "ready",
        diagnostics: { imuBufferedSamples: 12, realtimeBufferedSamples: 4 },
      },
      {
        id: "polar",
        kind: "heart-rate",
        name: "Polar H10",
        connectionState: "ready",
        diagnostics: {
          bufferedSampleCount: 2,
          lastHeartRateBpm: 61,
          lastMeasurementAt: "2026-08-24T19:00:00.000Z",
          lastRrIntervalsMs: [984],
        },
      },
      expect.objectContaining({ id: "wahoo", kind: "heart-rate" }),
    ]);
  });

  it("publishes an updated list when the heart-rate module emits a device change", async () => {
    const { subscribeBluetoothDevices } = await import("./bluetooth-device-catalog.ts");
    const listener = vi.fn();
    subscribeBluetoothDevices(listener);
    mockHeartRate.getDevices.mockResolvedValue([polar]);

    mockHeartRate.emitDeviceStateChanged(polar);

    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith({
        state: "ready",
        devices: [
          expect.objectContaining({ id: "whoop" }),
          expect.objectContaining({ id: "polar" }),
        ],
        error: null,
      }),
    );
  });

  it("publishes an updated list when WHOOP changes connection state", async () => {
    const { subscribeBluetoothDevices } = await import("./bluetooth-device-catalog.ts");
    const listener = vi.fn();
    subscribeBluetoothDevices(listener);
    mockWhoop.getDeviceSummary.mockReturnValue({
      id: "whoop-123",
      name: "WHOOP 4.0",
      connectionState: "connected",
      imuBufferedSamples: 3,
      realtimeBufferedSamples: 1,
    });

    mockWhoop.emitConnectionStateChanged({ state: "connected", peripheralId: "whoop-123" });

    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith({
        state: "ready",
        devices: [
          expect.objectContaining({
            id: "whoop",
            name: "WHOOP 4.0",
            peripheralId: "whoop-123",
            connectionState: "connected",
          }),
        ],
        error: null,
      }),
    );
  });

  it("publishes the native device error when a catalog refresh fails", async () => {
    const { subscribeBluetoothDevices } = await import("./bluetooth-device-catalog.ts");
    const listener = vi.fn();
    const error = new Error("Heart-rate device registry is unavailable");
    mockHeartRate.getDevices.mockRejectedValue(error);
    subscribeBluetoothDevices(listener);

    mockHeartRate.emitDeviceStateChanged(polar);

    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith({
        state: "error",
        devices: [],
        error: "Heart-rate device registry is unavailable",
      }),
    );
    expect(Sentry.captureException).toHaveBeenCalledWith(error, {
      tags: { source: "bluetooth-device-catalog-subscription" },
      extra: { source: "bluetooth-device-catalog-subscription" },
    });
  });

  it("removes both native subscriptions", async () => {
    const { subscribeBluetoothDevices } = await import("./bluetooth-device-catalog.ts");

    const subscription = subscribeBluetoothDevices(vi.fn());
    subscription.remove();

    expect(mockHeartRate.remove).toHaveBeenCalledOnce();
    expect(mockWhoop.remove).toHaveBeenCalledOnce();
  });
});
