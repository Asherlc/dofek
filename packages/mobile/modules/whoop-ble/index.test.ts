import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeModule = vi.hoisted(() => ({
  configureUpload: vi.fn(),
  flushUploads: vi.fn(),
  disableUploads: vi.fn(),
  addListener: vi.fn(),
  getDataPathStats: vi.fn(),
  getDeviceSummary: vi.fn(),
}));

vi.unmock("../whoop-ble");
vi.mock("./src/WhoopBleModule", () => ({ default: nativeModule }));

import { addDeviceStateListener, getDataPathStats, getDeviceSummary } from "./index";

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
    connectionDiagnostics: {
      overflowCount: 2,
      events: [
        {
          eventId: "11111111-1111-4111-8111-111111111111",
          occurredAt: "2026-10-23T02:59:00.000Z",
          nativeSessionId: "22222222-2222-4222-8222-222222222222",
          processId: 123,
          event: "disconnected",
          connectionState: "streaming",
          centralState: "poweredOn",
          reconnectIntent: true,
          peripheralId: "strap",
          errorDomain: "CBErrorDomain",
          errorCode: -7,
          errorDescription: "Connection lost",
        },
      ],
    },
    buffers: {
      activeUploadCount: 0,
      blockedUploadStreams: [],
      lastUploadError: null,
      ...makeBufferCheckpoint(),
    },
  };
}

describe("WhoopBle native bridge", () => {
  beforeEach(() => {
    nativeModule.addListener.mockReset();
    nativeModule.getDataPathStats.mockReset();
    nativeModule.getDeviceSummary.mockReset();
  });

  it("preserves validated capture diagnostics and durable queue metadata", () => {
    const stats = makeDataPathStats();
    nativeModule.getDataPathStats.mockReturnValue(stats);

    expect(getDataPathStats()).toEqual(stats);
  });

  it("accepts unavailable device and capture dates as null", () => {
    const stats = {
      ...makeDataPathStats(),
      lastKnownDeviceId: null,
      lastDataNotificationAt: null,
      lastParsedRealtimeAt: null,
      lastValidHeartRateAt: null,
      buffers: {
        activeUploadCount: 0,
        blockedUploadStreams: [],
        lastUploadError: null,
        ...makeBufferCheckpoint(),
      },
    };
    nativeModule.getDataPathStats.mockReturnValue(stats);

    expect(getDataPathStats()).toEqual(stats);
  });

  it.each([
    { field: "connectionDiagnostics", value: undefined },
    { field: "overflowCount", value: { events: [], overflowCount: -1 } },
    {
      field: "events",
      value: {
        events: Array(65).fill(makeDataPathStats().connectionDiagnostics.events[0]),
        overflowCount: 0,
      },
    },
    ...[
      ["eventId", "bad-id"],
      ["occurredAt", "yesterday"],
      ["nativeSessionId", "bad-id"],
      ["processId", 0.5],
      ["reconnectIntent", "true"],
      ["errorCode", "7"],
    ].map(([field, invalid]) => ({
      field,
      value: {
        overflowCount: 0,
        events: [
          {
            ...makeDataPathStats().connectionDiagnostics.events[0],
            [field]: invalid,
          },
        ],
      },
    })),
  ])("rejects malformed native connection journal $field", ({ field, value }) => {
    nativeModule.getDataPathStats.mockReturnValue({
      ...makeDataPathStats(),
      connectionDiagnostics: value,
    });
    expect(() => getDataPathStats()).toThrow(String(field));
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
      buffers: {
        activeUploadCount: 0,
        blockedUploadStreams: [],
        lastUploadError: null,
        ...stats.buffers,
        ...invalid,
      },
    });

    expect(() => getDataPathStats()).toThrow(field);
  });

  it("rejects malformed native summaries", () => {
    nativeModule.getDeviceSummary.mockReturnValue({ connectionState: "ready" });

    expect(() => getDeviceSummary()).toThrow(/id/);
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
});

describe("native upload ownership", () => {
  it("configures, flushes, and synchronously disables native uploads", async () => {
    const bridge = await import("./index");
    const context = {
      userId: "user",
      token: "secret",
      serverURL: "https://example.com",
      headers: { "x-app-version": "1" },
    };
    bridge.configureUpload(context);
    bridge.flushUploads();
    bridge.disableUploads();
    expect(nativeModule.configureUpload).toHaveBeenCalledWith(context);
    expect(nativeModule.flushUploads).toHaveBeenCalledOnce();
    expect(nativeModule.disableUploads).toHaveBeenCalledOnce();
  });
  it("propagates native disable failure synchronously", async () => {
    const bridge = await import("./index");
    nativeModule.disableUploads.mockImplementationOnce(() => {
      throw new Error("queue unavailable");
    });
    expect(() => bridge.disableUploads()).toThrow("queue unavailable");
  });
});
