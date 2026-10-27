import { randomUUID } from "expo-crypto";
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
type Stream = "imu" | "realtime";
export type WhoopSyncTrigger =
  | "initial"
  | "foreground"
  | "periodic"
  | "background"
  | "connection"
  | "app_state"
  | "teardown";

export interface WhoopUploadBatch {
  telemetry: { batchId: string; bufferInstanceId?: string };
  stream: Stream;
  deviceId: string;
  sampleCount: number;
  firstTimestamp: string | undefined;
  lastTimestamp: string | undefined;
  startedAt: number;
}

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
  #bufferInstanceId: string | undefined;
  #reportedCheckpointFor: string | undefined;
  #reportedConnectionEvents = new Set<string>();
  readonly #workers = new Map<Stream, { startedAt: number; trigger: WhoopSyncTrigger }>();
  readonly #requests = new Map<Stream, WhoopUploadBatch>();

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
    this.#bufferInstanceId = buffers.bufferInstanceId;
    const previous = buffers.previousCheckpoint;
    if (previous && this.#reportedCheckpointFor !== buffers.bufferInstanceId) {
      this.#reportedCheckpointFor = buffers.bufferInstanceId;
      logger.info("whoop-ble", "previous_buffer_checkpoint", {
        event: "previous_buffer_checkpoint",
        bufferInstanceId: buffers.bufferInstanceId,
        previousBufferInstanceId: previous.bufferInstanceId,
        previousBufferCreatedAt: previous.bufferCreatedAt,
        previousCheckpointAt: previous.checkpointAt,
        checkpointAccountProvenance: "unknown",
        ...bufferAttributes("previousImu", previous.imu),
        ...bufferAttributes("previousRealtime", previous.realtime),
      });
    }
    const workerAttributes: Record<string, string | number | boolean> = {};
    for (const stream of ["imu", "realtime"] as const) {
      const worker = this.#workers.get(stream);
      const request = this.#requests.get(stream);
      workerAttributes[`${stream}WorkerActive`] = worker !== undefined;
      workerAttributes[`${stream}RequestPending`] = request !== undefined;
      if (worker) {
        workerAttributes[`${stream}WorkerAgeMs`] = Date.now() - worker.startedAt;
        workerAttributes[`${stream}WorkerTrigger`] = worker.trigger;
      }
      if (request) {
        workerAttributes[`${stream}PendingRequestAgeMs`] = Date.now() - request.startedAt;
        workerAttributes[`${stream}PendingBatchId`] = request.telemetry.batchId;
      }
    }
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
      ...workerAttributes,
    });
  }

  workerStarted(stream: Stream, trigger: WhoopSyncTrigger): void {
    this.#workers.set(stream, { startedAt: Date.now(), trigger });
    logger.info("whoop-ble", "worker_started", {
      event: "worker_started",
      stream,
      trigger,
      bufferInstanceId: this.#bufferInstanceId,
    });
  }

  workerJoined(stream: Stream, trigger: WhoopSyncTrigger): void {
    logger.info("whoop-ble", "worker_joined", {
      event: "worker_joined",
      stream,
      trigger,
      bufferInstanceId: this.#bufferInstanceId,
    });
  }

  workerFinished(stream: Stream): void {
    const worker = this.#workers.get(stream);
    this.#workers.delete(stream);
    this.#requests.delete(stream);
    logger.info("whoop-ble", "worker_finished", {
      event: "worker_finished",
      stream,
      elapsedMs: worker ? Date.now() - worker.startedAt : 0,
      bufferInstanceId: this.#bufferInstanceId,
    });
  }

  uploadStarted<TSample extends { timestamp: string }>(
    stream: Stream,
    deviceId: string,
    samples: readonly TSample[],
  ): WhoopUploadBatch {
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (const sample of samples) {
      const timestamp = Date.parse(sample.timestamp);
      first = Math.min(first, timestamp);
      last = Math.max(last, timestamp);
    }
    const batch: WhoopUploadBatch = {
      telemetry: {
        batchId: randomUUID(),
        ...(this.#bufferInstanceId ? { bufferInstanceId: this.#bufferInstanceId } : {}),
      },
      stream,
      deviceId,
      sampleCount: samples.length,
      firstTimestamp: Number.isFinite(first) ? new Date(first).toISOString() : undefined,
      lastTimestamp: Number.isFinite(last) ? new Date(last).toISOString() : undefined,
      startedAt: Date.now(),
    };
    this.#requests.set(stream, batch);
    logger.info("whoop-ble", "upload_started", {
      event: "upload_started",
      ...this.#batchAttributes(batch),
    });
    return batch;
  }

  uploadAcknowledged(batch: WhoopUploadBatch, publishedRowCount: number): void {
    this.#requests.delete(batch.stream);
    logger.info("whoop-ble", "upload_acknowledged", {
      event: "upload_acknowledged",
      ...this.#batchAttributes(batch),
      publishedRowCount,
      elapsedMs: Date.now() - batch.startedAt,
    });
  }

  uploadFailed(batch: WhoopUploadBatch, error: unknown): void {
    this.#requests.delete(batch.stream);
    logger.warn("whoop-ble", "upload_failed", {
      event: "upload_failed",
      ...this.#batchAttributes(batch),
      errorName: error instanceof Error ? error.name : "unknown",
      elapsedMs: Date.now() - batch.startedAt,
    });
  }

  bufferConfirmed(
    stream: Stream,
    batches: readonly WhoopUploadBatch[],
    requestedConfirmationCount: number,
    requestedErasureDiscardCount: number,
  ): void {
    logger.info("whoop-ble", "buffer_confirmed", {
      event: "buffer_confirmed",
      stream,
      bufferInstanceId: this.#bufferInstanceId,
      batchIds: batches.map((batch) => batch.telemetry.batchId).join(","),
      requestedConfirmationCount,
      requestedErasureDiscardCount,
    });
  }

  skipped(stream: Stream, reason: string, trigger: WhoopSyncTrigger): void {
    logger.info("whoop-ble", "upload_skipped", {
      event: "upload_skipped",
      stream,
      reason,
      trigger,
      bufferInstanceId: this.#bufferInstanceId,
    });
  }

  #batchAttributes(batch: WhoopUploadBatch) {
    return {
      ...batch.telemetry,
      stream: batch.stream,
      deviceId: batch.deviceId,
      sampleCount: batch.sampleCount,
      firstTimestamp: batch.firstTimestamp,
      lastTimestamp: batch.lastTimestamp,
    };
  }
}
