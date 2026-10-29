import { vi } from "vitest";
import type { WhoopCaptureStats } from "./whoop-ble-diagnostics";
import type { WhoopBleSyncDeps } from "./whoop-ble-sync-types";

export function makeWhoopCaptureStats(): WhoopCaptureStats {
  const stream = {
    count: 0,
    oldestTimestamp: null,
    newestTimestamp: null,
    receivedCount: 0,
    confirmedCount: 0,
    overflowDiscardedCount: 0,
    erasureDiscardedCount: 0,
    clearedCount: 0,
    legacyDrainedCount: 0,
    lastConfirmedAt: null,
  };
  return {
    connectionDiagnostics: { events: [], overflowCount: 0 },
    dataNotificationCount: 0,
    totalFramesParsed: 0,
    malformedFrames: 0,
    connectionState: "streaming",
    isNotifying: true,
    lastDataNotificationAt: null,
    lastParsedImuAt: null,
    lastParsedRealtimeAt: null,
    lastValidHeartRateAt: null,
    lastKnownDeviceId: null,
    buffers: {
      activeUploadCount: 0,
      blockedUploadStreams: [],
      lastUploadError: null,
      bufferInstanceId: "11111111-1111-4111-8111-111111111111",
      bufferCreatedAt: "2026-10-23T00:00:00.000Z",
      checkpointAt: "2026-10-23T01:00:00.000Z",
      imu: { ...stream },
      realtime: { ...stream },
    },
  };
}

export function makeMockDeps(): WhoopBleSyncDeps {
  return {
    addCaptureErrorListener: vi.fn().mockReturnValue({ remove: vi.fn() }),
    configureUpload: vi.fn(),
    flushUploads: vi.fn(),
    findWhoop: vi.fn().mockResolvedValue({ id: "whoop-123", name: "WHOOP 4.0" }),
    connect: vi.fn().mockResolvedValue(true),
    startImuStreaming: vi.fn().mockResolvedValue(true),
    stopImuStreaming: vi.fn().mockResolvedValue(true),
    disconnect: vi.fn(),
    addConnectionStateListener: vi.fn().mockReturnValue({ remove: vi.fn() }),
    getDataPathStats: vi.fn().mockImplementation(makeWhoopCaptureStats),
  };
}
