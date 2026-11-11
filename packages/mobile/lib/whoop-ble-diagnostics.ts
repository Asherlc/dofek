import type { WhoopBufferStreamDiagnostics, WhoopDataPathStats } from "../modules/whoop-ble";
import { logger } from "./telemetry";

export type WhoopCaptureStats = Pick<
  WhoopDataPathStats,
  | "buffers"
  | "connectionDiagnostics"
  | "dataNotificationCount"
  | "totalFramesParsed"
  | "malformedFrames"
  | "connectionState"
  | "isNotifying"
  | "lastDataNotificationAt"
  | "lastParsedImuAt"
  | "lastParsedRealtimeAt"
  | "lastValidHeartRateAt"
  | "lastKnownDeviceId"
>;
export type WhoopSyncTrigger =
  | "initial"
  | "foreground"
  | "periodic"
  | "background"
  | "connection"
  | "app_state"
  | "teardown";

function bufferAttributes(prefix: string, buffer: WhoopBufferStreamDiagnostics) {
  return Object.fromEntries(
    (
      [
        "count",
        "oldestTimestamp",
        "newestTimestamp",
        "receivedCount",
        "confirmedCount",
        "overflowDiscardedCount",
        "erasureDiscardedCount",
        "clearedCount",
        "legacyDrainedCount",
        "lastConfirmedAt",
      ] as const
    ).map((key) => [`${prefix}${key[0]?.toUpperCase()}${key.slice(1)}`, buffer[key]]),
  );
}

/** Metadata-only capture and upload progress; never serializes sample values. */
export class WhoopBleDiagnostics {
  #reportedConnectionEvents = new Set<string>();

  snapshot(stats: WhoopCaptureStats, trigger: WhoopSyncTrigger, appState: string): void {
    const { buffers } = stats;
    const retainedEventIds = new Set<string>();
    for (const nativeEvent of stats.connectionDiagnostics.events) {
      retainedEventIds.add(nativeEvent.eventId);
      if (this.#reportedConnectionEvents.has(nativeEvent.eventId)) continue;
      logger.info("whoop-ble", "native_connection_event", {
        event: "native_connection_event",
        eventId: nativeEvent.eventId,
        nativeEvent: nativeEvent.event,
        nativeOccurredAt: nativeEvent.occurredAt,
        nativeSessionId: nativeEvent.nativeSessionId,
        processId: nativeEvent.processId,
        connectionState: nativeEvent.connectionState,
        centralState: nativeEvent.centralState,
        reconnectIntent: nativeEvent.reconnectIntent,
        peripheralId: nativeEvent.peripheralId,
        errorDomain: nativeEvent.errorDomain,
        errorCode: nativeEvent.errorCode,
        errorDescription: nativeEvent.errorDescription,
        reason: nativeEvent.reason,
        previousConnectionState: nativeEvent.previousConnectionState,
        restoredPeripheralCount: nativeEvent.restoredPeripheralCount,
        connectionAccountProvenance: "unknown",
        connectionHistoryOverflowCount: stats.connectionDiagnostics.overflowCount,
        trigger,
        appState,
      });
    }
    this.#reportedConnectionEvents = retainedEventIds;
    const capture = {
      dataNotificationCount: stats.dataNotificationCount,
      totalFramesParsed: stats.totalFramesParsed,
      malformedFrames: stats.malformedFrames,
      connectionState: stats.connectionState,
      isNotifying: stats.isNotifying,
      lastDataNotificationAt: stats.lastDataNotificationAt,
      lastParsedImuAt: stats.lastParsedImuAt,
      lastParsedRealtimeAt: stats.lastParsedRealtimeAt,
      lastValidHeartRateAt: stats.lastValidHeartRateAt,
      lastKnownDeviceId: stats.lastKnownDeviceId,
    };
    logger.info("whoop-ble", "capture_snapshot", {
      event: "capture_snapshot",
      trigger,
      appState,
      ...capture,
      bufferInstanceId: buffers.bufferInstanceId,
      bufferCreatedAt: buffers.bufferCreatedAt,
      checkpointAt: buffers.checkpointAt,
      ...bufferAttributes("imu", buffers.imu),
      ...bufferAttributes("realtime", buffers.realtime),
      ...bufferAttributes("sensorRecords", buffers.sensorRecords),
      activeUploadCount: buffers.activeUploadCount,
      blockedUploadStreams: buffers.blockedUploadStreams.join(","),
      lastUploadError: buffers.lastUploadError,
    });
  }
}
