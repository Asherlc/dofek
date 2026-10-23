import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeModule = vi.hoisted(() => ({
  addListener: vi.fn(),
  getBufferedSamples: vi.fn(),
  getDataPathStats: vi.fn(),
  getDeviceSummary: vi.fn(),
  peekBufferedSamples: vi.fn(),
  peekBufferedRealtimeData: vi.fn(),
}));

vi.unmock("../whoop-ble");
vi.mock("./src/WhoopBleModule", () => ({ default: nativeModule }));

import {
  addDeviceStateListener,
  getDataPathStats,
  getDeviceSummary,
  peekBufferedRealtimeData,
  peekBufferedSamples,
} from "./index";

function makeBufferStreamDiagnostics() {
  return {
    count: 0,
    oldestTimestamp: null,
    newestTimestamp: null,
    receivedCount: 4,
    confirmedCount: 3,
    overflowDiscardedCount: 0,
    erasureDiscardedCount: 0,
    clearedCount: 1,
    legacyDrainedCount: 0,
    lastConfirmedAt: "2026-10-23T03:00:00.000Z",
  };
}

function makeBufferCheckpoint() {
  return {
    bufferInstanceId: "9a5b18b9-6037-47b7-ac55-fc2484191178",
    bufferCreatedAt: "2026-10-23T02:00:00.000Z",
    checkpointAt: "2026-10-23T03:00:00.000Z",
    imu: makeBufferStreamDiagnostics(),
    realtime: {
      ...makeBufferStreamDiagnostics(),
      count: 1,
      oldestTimestamp: "2026-10-23T02:59:00.000Z",
      newestTimestamp: "2026-10-23T02:59:00.000Z",
      clearedCount: 0,
      lastConfirmedAt: null,
    },
  };
}

function makeDataPathStats() {
  return {
    dataNotificationCount: 100,
    cmdNotificationCount: 2,
    totalFramesParsed: 100,
    totalSamplesExtracted: 40,
    emptyExtractions: 0,
    bufferOverflows: 0,
    packetTypes: "0x28:100",
    lastCommandResponse: "",
    connectionState: "ready",
    lastKnownDeviceId: "WHOOP Strap",
    hasDataCharacteristic: true,
    isNotifying: true,
    hasCmdCharacteristic: true,
    hasCmdResponseCharacteristic: true,
    lastWriteError: "none",
    watchdogRetryCount: 0,
    malformedFrames: 0,
    malformedCmdFrames: 0,
    coalescedFrames: 0,
    coalescedCmdFrames: 0,
    realtimeBufferCount: 1,
    lastDataNotificationAt: "2026-10-23T03:00:00.000Z",
    lastParsedImuAt: null,
    lastParsedRealtimeAt: "2026-10-23T03:00:00.000Z",
    lastValidHeartRateAt: "2026-10-23T02:59:00.000Z",
    buffers: {
      ...makeBufferCheckpoint(),
      previousCheckpoint: makeBufferCheckpoint(),
    },
  };
}

describe("WhoopBle native bridge", () => {
  beforeEach(() => {
    nativeModule.addListener.mockReset();
    nativeModule.getDataPathStats.mockReset();
    nativeModule.getDeviceSummary.mockReset();
    nativeModule.peekBufferedSamples.mockReset();
    nativeModule.peekBufferedRealtimeData.mockReset();
  });

  it("preserves validated capture diagnostics and current and previous buffer checkpoints", () => {
    const stats = makeDataPathStats();
    nativeModule.getDataPathStats.mockReturnValue(stats);

    expect(getDataPathStats()).toEqual(stats);
  });

  it("accepts unavailable device, capture dates and previous checkpoint as null", () => {
    const stats = {
      ...makeDataPathStats(),
      lastKnownDeviceId: null,
      lastDataNotificationAt: null,
      lastParsedRealtimeAt: null,
      lastValidHeartRateAt: null,
      buffers: { ...makeBufferCheckpoint(), previousCheckpoint: null },
    };
    nativeModule.getDataPathStats.mockReturnValue(stats);

    expect(getDataPathStats()).toEqual(stats);
  });

  it.each([
    { field: "dataNotificationCount", invalid: { dataNotificationCount: "100" } },
    { field: "isNotifying", invalid: { isNotifying: "true" } },
    { field: "lastDataNotificationAt", invalid: { lastDataNotificationAt: "yesterday" } },
    { field: "totalSamplesExtracted", invalid: { totalSamplesExtracted: -1 } },
  ])("rejects malformed native capture field $field", ({ field, invalid }) => {
    nativeModule.getDataPathStats.mockReturnValue({ ...makeDataPathStats(), ...invalid });

    expect(() => getDataPathStats()).toThrow(field);
  });

  it.each([
    { field: "bufferInstanceId", invalid: { bufferInstanceId: "not-a-uuid" } },
    { field: "checkpointAt", invalid: { checkpointAt: "yesterday" } },
    {
      field: "count",
      invalid: { imu: { ...makeBufferStreamDiagnostics(), count: -1 } },
    },
    {
      field: "confirmedCount",
      invalid: { realtime: { ...makeBufferStreamDiagnostics(), confirmedCount: 0.5 } },
    },
  ])("rejects malformed current buffer checkpoint field $field", ({ field, invalid }) => {
    const stats = makeDataPathStats();
    nativeModule.getDataPathStats.mockReturnValue({
      ...stats,
      buffers: { ...stats.buffers, ...invalid },
    });

    expect(() => getDataPathStats()).toThrow(field);
  });

  it("rejects malformed previous buffer checkpoint counters", () => {
    const stats = makeDataPathStats();
    nativeModule.getDataPathStats.mockReturnValue({
      ...stats,
      buffers: {
        ...stats.buffers,
        previousCheckpoint: {
          ...makeBufferCheckpoint(),
          imu: { ...makeBufferStreamDiagnostics(), overflowDiscardedCount: "1" },
        },
      },
    });

    expect(() => getDataPathStats()).toThrow(/previousCheckpoint/);
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
