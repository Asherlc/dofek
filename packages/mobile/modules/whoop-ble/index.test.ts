import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeModule = vi.hoisted(() => ({
  configureUpload: vi.fn(),
  flushUploads: vi.fn(),
  disableUploads: vi.fn(),
  purgeAccountState: vi.fn(),
  addListener: vi.fn(),
  getDataPathStats: vi.fn(),
  getDeviceSummary: vi.fn(),
}));
const secureStore = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
  AFTER_FIRST_UNLOCK: "kSecAttrAccessibleAfterFirstUnlock",
}));

vi.unmock("../whoop-ble");
vi.mock("./src/WhoopBleModule", () => ({ default: nativeModule }));
vi.mock("expo-secure-store", () => secureStore);

import { addDeviceStateListener, getDataPathStats, getDeviceSummary } from "./index";

const cleanupIntentKey = "dofek_whoop_cleanup_intent_v1";
const uploadContext = {
  userId: "user",
  token: "secret",
  serverURL: "https://example.com",
  headers: { "x-app-version": "1" },
};

function useSecureStore(values = new Map<string, string>()) {
  secureStore.getItemAsync.mockImplementation(async (key: string) => values.get(key) ?? null);
  secureStore.setItemAsync.mockImplementation(async (key: string, value: string) => {
    values.set(key, value);
  });
  secureStore.deleteItemAsync.mockImplementation(async (key: string) => {
    values.delete(key);
  });
  return values;
}

beforeEach(() => {
  nativeModule.configureUpload.mockReset().mockResolvedValue(undefined);
  nativeModule.flushUploads.mockReset().mockResolvedValue(undefined);
  nativeModule.disableUploads.mockReset().mockResolvedValue(undefined);
  nativeModule.purgeAccountState.mockReset().mockResolvedValue(true);
  nativeModule.addListener.mockReset();
  nativeModule.getDataPathStats.mockReset();
  nativeModule.getDeviceSummary.mockReset();
  secureStore.getItemAsync.mockReset().mockResolvedValue(null);
  secureStore.setItemAsync.mockReset().mockResolvedValue(undefined);
  secureStore.deleteItemAsync.mockReset().mockResolvedValue(undefined);
});

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
    sensorRecords: makeBufferStreamDiagnostics(),
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
  it("reports a blocked sensor-record upload without losing capture diagnostics", async () => {
    const stats = makeDataPathStats();
    nativeModule.getDataPathStats.mockResolvedValue({
      ...stats,
      buffers: { ...stats.buffers, blockedUploadStreams: ["sensorRecords"] },
    });
    expect((await getDataPathStats()).buffers.blockedUploadStreams).toEqual(["sensorRecords"]);
  });
  it("preserves validated capture diagnostics and durable queue metadata", async () => {
    const stats = makeDataPathStats();
    nativeModule.getDataPathStats.mockResolvedValue(stats);

    await expect(getDataPathStats()).resolves.toEqual(stats);
  });

  it("accepts unavailable device and capture dates as null", async () => {
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
    nativeModule.getDataPathStats.mockResolvedValue(stats);

    await expect(getDataPathStats()).resolves.toEqual(stats);
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
  ])("rejects malformed native connection journal $field", async ({ field, value }) => {
    nativeModule.getDataPathStats.mockResolvedValue({
      ...makeDataPathStats(),
      connectionDiagnostics: value,
    });
    await expect(getDataPathStats()).rejects.toThrow(String(field));
  });

  it.each([
    { field: "dataNotificationCount", invalid: { dataNotificationCount: "100" } },
    { field: "isNotifying", invalid: { isNotifying: "true" } },
    { field: "lastDataNotificationAt", invalid: { lastDataNotificationAt: "yesterday" } },
    { field: "totalSamplesExtracted", invalid: { totalSamplesExtracted: -1 } },
  ])("rejects malformed native capture field $field", async ({ field, invalid }) => {
    nativeModule.getDataPathStats.mockResolvedValue({ ...makeDataPathStats(), ...invalid });

    await expect(getDataPathStats()).rejects.toThrow(field);
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
  ])("rejects malformed current buffer checkpoint field $field", async ({ field, invalid }) => {
    const stats = makeDataPathStats();
    nativeModule.getDataPathStats.mockResolvedValue({
      ...stats,
      buffers: {
        activeUploadCount: 0,
        blockedUploadStreams: [],
        lastUploadError: null,
        ...stats.buffers,
        ...invalid,
      },
    });

    await expect(getDataPathStats()).rejects.toThrow(field);
  });

  it("rejects malformed native summaries", async () => {
    nativeModule.getDeviceSummary.mockResolvedValue({ connectionState: "ready" });

    await expect(getDeviceSummary()).rejects.toThrow(/id/);
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
  it("awaits configuring, flushing, and disabling native uploads", async () => {
    const bridge = await import("./index");
    const context = {
      userId: "user",
      token: "secret",
      serverURL: "https://example.com",
      headers: { "x-app-version": "1" },
    };
    await bridge.configureUpload(context);
    await bridge.flushUploads();
    await bridge.disableUploads();
    expect(nativeModule.configureUpload).toHaveBeenCalledWith(context);
    expect(nativeModule.flushUploads).toHaveBeenCalledOnce();
    expect(nativeModule.disableUploads).toHaveBeenCalledOnce();
  });
  it("rejects with the native disable failure", async () => {
    const bridge = await import("./index");
    nativeModule.disableUploads.mockImplementationOnce(() => {
      throw new Error("queue unavailable");
    });
    await expect(bridge.disableUploads()).rejects.toThrow("queue unavailable");
  });
});

describe("WHOOP cleanup intent configuration fence", () => {
  it("dispatches a replacement configuration after disable enters the native FIFO", async () => {
    vi.resetModules();
    const persisted = useSecureStore();
    const helper = await import("../../lib/whoop-cleanup-intent");
    await helper.persistWhoopCleanupIntent();
    expect(persisted.has(cleanupIntentKey)).toBe(true);
    const bridge = await import("./index");
    let finishCleanup!: () => void;
    const pendingCleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    nativeModule.disableUploads.mockImplementationOnce(() => pendingCleanup);
    const cleanup = bridge.disableUploads();
    const configuring = bridge.configureUpload(uploadContext);
    try {
      await vi.waitFor(() => expect(nativeModule.configureUpload).toHaveBeenCalledOnce());
      expect(nativeModule.configureUpload.mock.invocationCallOrder[0]).toBeGreaterThan(
        nativeModule.disableUploads.mock.invocationCallOrder[0] ?? 0,
      );
    } finally {
      finishCleanup();
      await Promise.all([cleanup, configuring]);
    }
  });

  it("blocks same-account configuration when an unknown intent survives a fresh module load", async () => {
    useSecureStore(new Map([[cleanupIntentKey, "pending-cleanup"]]));
    vi.resetModules();
    const bridge = await import("./index");

    await expect(bridge.configureUpload(uploadContext)).rejects.toThrow();
    expect(nativeModule.configureUpload).not.toHaveBeenCalled();
  });

  it("rejects configuration when reading cleanup intent fails", async () => {
    const readFailure = new Error("SecureStore is unavailable");
    secureStore.getItemAsync.mockRejectedValueOnce(readFailure);
    vi.resetModules();
    const bridge = await import("./index");

    await expect(bridge.configureUpload(uploadContext)).rejects.toBe(readFailure);
    expect(nativeModule.configureUpload).not.toHaveBeenCalled();
  });

  it.each(["disable", "purge"] as const)(
    "does not dispatch a configuration whose delayed intent read is overtaken by %s",
    async (cleanup) => {
      let finishRead: ((value: string | null) => void) | undefined;
      secureStore.getItemAsync.mockImplementationOnce(
        () => new Promise<string | null>((resolve) => (finishRead = resolve)),
      );
      vi.resetModules();
      const bridge = await import("./index");
      const configuring = bridge.configureUpload(uploadContext);
      try {
        await vi.waitFor(() => expect(secureStore.getItemAsync).toHaveBeenCalledOnce());
        expect(nativeModule.configureUpload).not.toHaveBeenCalled();

        if (cleanup === "disable") {
          await bridge.disableUploads();
          expect(nativeModule.disableUploads).toHaveBeenCalledOnce();
        } else {
          await bridge.purgeAccountState("2026-11-11T00:00:00.000Z");
          expect(nativeModule.purgeAccountState).toHaveBeenCalledOnce();
        }

        finishRead?.(null);
        await expect(configuring).rejects.toThrow();
        expect(nativeModule.configureUpload).not.toHaveBeenCalled();
      } finally {
        finishRead?.(null);
        await Promise.allSettled([configuring]);
      }
    },
  );
});
