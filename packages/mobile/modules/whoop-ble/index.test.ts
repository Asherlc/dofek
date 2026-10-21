import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeModule = vi.hoisted(() => ({
  addListener: vi.fn(),
  getBufferedSamples: vi.fn(),
  getDeviceSummary: vi.fn(),
  peekBufferedSamples: vi.fn(),
  peekBufferedRealtimeData: vi.fn(),
}));

vi.unmock("../whoop-ble");
vi.mock("./src/WhoopBleModule", () => ({ default: nativeModule }));

import {
  addDeviceStateListener,
  getDeviceSummary,
  peekBufferedRealtimeData,
  peekBufferedSamples,
} from "./index";

describe("WhoopBle native bridge", () => {
  beforeEach(() => {
    nativeModule.addListener.mockReset();
    nativeModule.getDeviceSummary.mockReset();
    nativeModule.peekBufferedSamples.mockReset();
    nativeModule.peekBufferedRealtimeData.mockReset();
  });

  it("rejects malformed native summaries", () => {
    nativeModule.getDeviceSummary.mockReturnValue({ connectionState: "ready" });

    expect(() => getDeviceSummary()).toThrow(/id/);
  });

  it("rejects buffered samples without a captured device ID", async () => {
    nativeModule.peekBufferedSamples.mockResolvedValue([
      {
        timestamp: "2026-08-24T19:00:00.000Z",
        accelerometerX: 0,
        accelerometerY: 0,
        accelerometerZ: 0,
        gyroscopeX: 0,
        gyroscopeY: 0,
        gyroscopeZ: 0,
      },
    ]);

    await expect(peekBufferedSamples()).rejects.toThrow(/deviceId/);
  });

  it("rejects malformed native device-state events", () => {
    const listener = vi.fn();
    nativeModule.addListener.mockReturnValue({ remove: vi.fn() });

    addDeviceStateListener(listener);
    const onDeviceState = nativeModule.addListener.mock.calls[0][1];
    if (typeof onDeviceState !== "function") {
      throw new Error("Expected native device-state listener");
    }

    expect(() => onDeviceState({ connectionState: "ready" })).toThrow(/id/);
  });

  it("preserves native reported heart rate without requiring beat intervals", async () => {
    const sample = {
      deviceId: "whoop-a",
      timestamp: "2026-10-20T16:03:26.000Z",
      heartRateBpm: 128,
      rrIntervalMs: 0,
      quaternionW: 0,
      quaternionX: 0,
      quaternionY: 0,
      quaternionZ: 0,
      opticalRawHex: "000000000000000000000000000000000000",
    };
    nativeModule.peekBufferedRealtimeData.mockResolvedValue([sample]);

    expect(await peekBufferedRealtimeData()).toEqual([sample]);
  });

  it("rejects malformed native reported heart rate", async () => {
    nativeModule.peekBufferedRealtimeData.mockResolvedValue([
      {
        deviceId: "whoop-a",
        timestamp: "2026-10-20T16:03:26.000Z",
        heartRateBpm: "128",
        rrIntervalMs: 0,
        quaternionW: 0,
        quaternionX: 0,
        quaternionY: 0,
        quaternionZ: 0,
        opticalRawHex: "000000000000000000000000000000000000",
      },
    ]);

    await expect(peekBufferedRealtimeData()).rejects.toThrow(/heartRateBpm/);
  });
});
