import * as Sentry from "@sentry/react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WhoopDeviceSummary } from "../modules/whoop-ble";

const mockHeartRate = vi.hoisted(() => {
  let stateListener: ((snapshot: unknown) => void) | undefined;
  let listListener: (() => void) | undefined;
  const removeState = vi.fn();
  const removeList = vi.fn();

  return {
    addDeviceStateListener: vi.fn((callback: (snapshot: unknown) => void) => {
      stateListener = callback;
      return { remove: removeState };
    }),
    addDeviceListListener: vi.fn((callback: () => void) => {
      listListener = callback;
      return { remove: removeList };
    }),
    emitDeviceStateChanged(snapshot: unknown) {
      stateListener?.(snapshot);
    },
    emitDeviceListChanged() {
      listListener?.();
    },
    getDevices: vi.fn(),
    removeList,
    removeState,
    reset() {
      stateListener = undefined;
      listListener = undefined;
      removeState.mockReset();
      removeList.mockReset();
      this.addDeviceStateListener.mockClear();
      this.addDeviceListListener.mockClear();
      this.getDevices.mockReset();
    },
  };
});

const mockWhoop = vi.hoisted(() => {
  let listener: ((event: WhoopDeviceSummary) => void) | undefined;
  const remove = vi.fn();

  return {
    addDeviceStateListener: vi.fn((callback: (event: WhoopDeviceSummary) => void) => {
      listener = callback;
      return { remove };
    }),
    emitDeviceStateChanged(event: WhoopDeviceSummary) {
      listener?.(event);
    },
    getDeviceSummary: vi.fn<() => Promise<WhoopDeviceSummary>>(),
    remove,
    reset() {
      listener = undefined;
      remove.mockReset();
      this.addDeviceStateListener.mockClear();
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
    mockWhoop.getDeviceSummary.mockResolvedValue({
      id: null,
      name: null,
      connectionState: "idle",
      imuBufferedSamples: 0,
      realtimeBufferedSamples: 0,
      battery: { percentage: null, isCharging: null },
    });
  });

  it("lists WHOOP before every persisted heart-rate monitor", async () => {
    mockHeartRate.getDevices.mockResolvedValue([polar, wahoo]);
    mockWhoop.getDeviceSummary.mockResolvedValue({
      id: null,
      name: null,
      connectionState: "ready",
      imuBufferedSamples: 12,
      realtimeBufferedSamples: 4,
      battery: { percentage: 49.9, isCharging: false },
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
        battery: { percentage: 49.9, isCharging: false },
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

  it("surfaces unsupported WHOOP devices with machine connectionState and an optional flag", async () => {
    mockWhoop.getDeviceSummary.mockResolvedValue({
      id: "whoop-legacy",
      name: "WHOOP MG",
      connectionState: "idle",
      imuBufferedSamples: 0,
      realtimeBufferedSamples: 0,
      battery: { percentage: null, isCharging: null },
      unsupportedDevice: true,
    });

    const { getBluetoothDevices } = await import("./bluetooth-device-catalog.ts");

    await expect(getBluetoothDevices()).resolves.toEqual([
      expect.objectContaining({
        id: "whoop",
        kind: "whoop",
        name: "WHOOP MG",
        peripheralId: "whoop-legacy",
        connectionState: "idle",
        unsupportedDevice: true,
      }),
    ]);
  });

  it("publishes unsupportedDevice from a WHOOP device-state event and clears it on ready", async () => {
    const { subscribeBluetoothDevices } = await import("./bluetooth-device-catalog.ts");
    const listener = vi.fn();
    subscribeBluetoothDevices(listener);

    const unsupported = {
      id: "whoop-legacy",
      name: "WHOOP MG",
      connectionState: "idle",
      imuBufferedSamples: 0,
      realtimeBufferedSamples: 0,
      battery: { percentage: null, isCharging: null },
      unsupportedDevice: true,
    } satisfies WhoopDeviceSummary;
    mockWhoop.getDeviceSummary.mockResolvedValue(unsupported);
    mockWhoop.emitDeviceStateChanged(unsupported);

    await vi.waitFor(() =>
      expect(listener).toHaveBeenLastCalledWith({
        state: "ready",
        devices: [
          expect.objectContaining({
            id: "whoop",
            name: "WHOOP MG",
            peripheralId: "whoop-legacy",
            connectionState: "idle",
            unsupportedDevice: true,
          }),
        ],
        error: null,
      }),
    );

    const ready = {
      id: "whoop-legacy",
      name: "WHOOP MG",
      connectionState: "ready",
      imuBufferedSamples: 0,
      realtimeBufferedSamples: 0,
      battery: { percentage: 57, isCharging: false },
    } satisfies WhoopDeviceSummary;
    mockWhoop.getDeviceSummary.mockResolvedValue(ready);
    mockWhoop.emitDeviceStateChanged(ready);

    await vi.waitFor(() =>
      expect(listener).toHaveBeenLastCalledWith({
        state: "ready",
        devices: [
          {
            id: "whoop",
            kind: "whoop",
            name: "WHOOP MG",
            peripheralId: "whoop-legacy",
            connectionState: "ready",
            battery: { percentage: 57, isCharging: false },
            diagnostics: { imuBufferedSamples: 0, realtimeBufferedSamples: 0 },
          },
        ],
        error: null,
      }),
    );
    expect(listener.mock.lastCall?.[0].devices[0]).not.toHaveProperty("unsupportedDevice");
  });

  it("publishes battery-only updates from the WHOOP native device-state listener", async () => {
    const { subscribeBluetoothDevices } = await import("./bluetooth-device-catalog.ts");
    const listener = vi.fn();
    subscribeBluetoothDevices(listener);
    const summary = {
      id: "whoop-123",
      name: "WHOOP MG",
      connectionState: "streaming",
      imuBufferedSamples: 3,
      realtimeBufferedSamples: 1,
      battery: { percentage: 0, isCharging: true },
    };
    mockWhoop.getDeviceSummary.mockResolvedValue(summary);
    mockWhoop.emitDeviceStateChanged(summary);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());

    const changed = { ...summary, battery: { percentage: 0, isCharging: false } };
    mockWhoop.getDeviceSummary.mockResolvedValue(changed);
    mockWhoop.emitDeviceStateChanged(changed);

    await vi.waitFor(() =>
      expect(listener).toHaveBeenLastCalledWith({
        state: "ready",
        devices: [
          expect.objectContaining({
            id: "whoop",
            name: "WHOOP MG",
            peripheralId: "whoop-123",
            connectionState: "streaming",
            battery: { percentage: 0, isCharging: false },
          }),
        ],
        error: null,
      }),
    );
  });

  it("publishes an updated list when a heart-rate monitor is forgotten", async () => {
    const { subscribeBluetoothDevices } = await import("./bluetooth-device-catalog.ts");
    const listener = vi.fn();
    mockHeartRate.getDevices.mockResolvedValue([polar]);
    subscribeBluetoothDevices(listener);
    mockHeartRate.getDevices.mockResolvedValue([]);

    mockHeartRate.emitDeviceListChanged();

    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith({
        state: "ready",
        devices: [expect.objectContaining({ id: "whoop" })],
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
      extra: expect.objectContaining({ source: "bluetooth-device-catalog-subscription" }),
    });
  });

  it("does not let an older refresh overwrite a newer device state", async () => {
    let resolveFirst: ((devices: (typeof polar)[]) => void) | undefined;
    const firstRefresh = new Promise<(typeof polar)[]>((resolve) => {
      resolveFirst = resolve;
    });
    mockHeartRate.getDevices.mockReturnValueOnce(firstRefresh).mockResolvedValueOnce([wahoo]);
    const { subscribeBluetoothDevices } = await import("./bluetooth-device-catalog.ts");
    const listener = vi.fn();
    subscribeBluetoothDevices(listener);

    mockHeartRate.emitDeviceStateChanged(polar);
    mockHeartRate.emitDeviceStateChanged(wahoo);

    await vi.waitFor(() =>
      expect(listener).toHaveBeenLastCalledWith({
        state: "ready",
        devices: [
          expect.objectContaining({ id: "whoop" }),
          expect.objectContaining({ id: "wahoo" }),
        ],
        error: null,
      }),
    );
    resolveFirst?.([polar]);
    await Promise.resolve();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("removes every native subscription", async () => {
    const { subscribeBluetoothDevices } = await import("./bluetooth-device-catalog.ts");

    const subscription = subscribeBluetoothDevices(vi.fn());
    subscription.remove();

    expect(mockHeartRate.removeState).toHaveBeenCalledOnce();
    expect(mockHeartRate.removeList).toHaveBeenCalledOnce();
    expect(mockWhoop.remove).toHaveBeenCalledOnce();
  });
});
