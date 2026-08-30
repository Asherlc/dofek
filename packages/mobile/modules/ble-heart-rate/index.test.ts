import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeModule = vi.hoisted(() => ({
  addListener: vi.fn(),
  getDevices: vi.fn(),
  peekBufferedSamples: vi.fn(),
}));

vi.unmock("../ble-heart-rate");
vi.mock("./src/BleHeartRateModule", () => ({ default: nativeModule }));

import {
  addDeviceStateListener,
  addHeartRateListener,
  getDevices,
  peekBufferedSamples,
} from "./index";

describe("BleHeartRate native bridge", () => {
  beforeEach(() => {
    nativeModule.addListener.mockReset();
    nativeModule.getDevices.mockReset();
    nativeModule.peekBufferedSamples.mockReset();
  });

  it("rejects malformed device snapshots returned by native code", () => {
    nativeModule.getDevices.mockReturnValue([{ id: "polar" }]);

    expect(() => getDevices()).toThrow(/connectionState/);
  });

  it("accepts a freshly paired monitor whose optional fields are undefined", () => {
    nativeModule.getDevices.mockReturnValue([
      {
        id: "polar",
        name: undefined,
        connectionState: "connected",
        lastMeasurementAt: undefined,
        lastHeartRateBpm: undefined,
      },
    ]);

    expect(getDevices()).toEqual([
      {
        id: "polar",
        name: null,
        connectionState: "connected",
        lastMeasurementAt: null,
        lastHeartRateBpm: null,
        lastRrIntervalsMs: [],
        bufferedSampleCount: 0,
      },
    ]);
  });

  it("accepts a device-state event whose optional fields are undefined", () => {
    const subscription = { remove: vi.fn() };
    const deviceStateListener = vi.fn();
    nativeModule.addListener.mockReturnValue(subscription);

    addDeviceStateListener(deviceStateListener);

    const onDeviceState = nativeModule.addListener.mock.calls[0][1];
    if (typeof onDeviceState !== "function") {
      throw new Error("Expected native bridge listener");
    }

    onDeviceState({
      id: "polar",
      name: undefined,
      connectionState: "connected",
      lastMeasurementAt: undefined,
      lastHeartRateBpm: undefined,
    });

    expect(deviceStateListener).toHaveBeenCalledWith({
      id: "polar",
      name: null,
      connectionState: "connected",
      lastMeasurementAt: null,
      lastHeartRateBpm: null,
      lastRrIntervalsMs: [],
      bufferedSampleCount: 0,
    });
  });

  it("rejects buffered samples without a captured device ID", async () => {
    nativeModule.peekBufferedSamples.mockResolvedValue([
      { timestamp: "2026-08-24T19:00:00.000Z", heartRateBpm: 61, rrIntervalsMs: [] },
    ]);

    await expect(peekBufferedSamples()).rejects.toThrow(/deviceId/);
  });

  it("rejects malformed native device-state and measurement events", () => {
    const subscription = { remove: vi.fn() };
    const deviceStateListener = vi.fn();
    const measurementListener = vi.fn();
    nativeModule.addListener.mockReturnValue(subscription);

    addDeviceStateListener(deviceStateListener);
    addHeartRateListener(measurementListener);

    const onDeviceState = nativeModule.addListener.mock.calls[0][1];
    const onMeasurement = nativeModule.addListener.mock.calls[1][1];
    if (typeof onDeviceState !== "function" || typeof onMeasurement !== "function") {
      throw new Error("Expected native bridge listeners");
    }

    expect(() => onDeviceState({ id: "polar" })).toThrow(/connectionState/);
    expect(() => onMeasurement({ heartRateBpm: 61 })).toThrow(/deviceId/);
  });
});
