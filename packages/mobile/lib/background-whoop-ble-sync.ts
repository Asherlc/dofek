import type { InertialMeasurementUnitSample } from "@dofek/imu";
import * as Sentry from "@sentry/react-native";
import { AppState, type AppStateStatus } from "react-native";
import { isAfterDeviceErasureCutoff, loadDeviceErasureCutoff } from "./device-erasure-cutoff";
import { DeviceSampleGroups, type DeviceScopedSample } from "./device-sample-groups.ts";
import type { InertialMeasurementUnitUploadClient } from "./inertial-measurement-unit-service";
import { captureException, logger } from "./telemetry";

const PERIODIC_DRAIN_INTERVAL_MS = 30_000; // Upload buffered samples every 30s
const LOG_CATEGORY = "whoop-ble";
const IMU_UPLOAD_BATCH_SIZE = 500;
const REALTIME_UPLOAD_BATCH_SIZE = 500;
const DEFAULT_WHOOP_DEVICE_ID = "WHOOP Strap";

type BufferedInertialMeasurementUnitSample = InertialMeasurementUnitSample & DeviceScopedSample;
type ShouldContinueUploading = () => boolean;
type RealtimeDataSample = {
  deviceId?: string;
  timestamp: string;
  rrIntervalMs: number;
  quaternionW: number;
  quaternionX: number;
  quaternionY: number;
  quaternionZ: number;
  opticalRawHex: string;
};

function toInertialMeasurementUnitUploadSample(
  sample: BufferedInertialMeasurementUnitSample,
): InertialMeasurementUnitSample {
  return {
    timestamp: sample.timestamp,
    x: sample.x,
    y: sample.y,
    z: sample.z,
    gyroscopeX: sample.gyroscopeX,
    gyroscopeY: sample.gyroscopeY,
    gyroscopeZ: sample.gyroscopeZ,
  };
}

function toRealtimeDataUploadSample(
  sample: RealtimeDataSample,
): Omit<RealtimeDataSample, "deviceId"> {
  return {
    timestamp: sample.timestamp,
    rrIntervalMs: sample.rrIntervalMs,
    quaternionW: sample.quaternionW,
    quaternionX: sample.quaternionX,
    quaternionY: sample.quaternionY,
    quaternionZ: sample.quaternionZ,
    opticalRawHex: sample.opticalRawHex,
  };
}

/** Dependencies injected for testability (wraps the whoop-ble native module) */
export interface WhoopBleSyncDeps {
  isBluetoothAvailable(): boolean;
  findWhoop(): Promise<{ id: string; name: string | null } | null>;
  connect(peripheralId: string): Promise<boolean>;
  startImuStreaming(): Promise<boolean>;
  stopImuStreaming(): Promise<boolean>;
  peekBufferedSamples(maxCount?: number): Promise<BufferedInertialMeasurementUnitSample[]>;
  confirmSamplesDrain(count: number): void;
  peekBufferedRealtimeData(maxCount?: number): Promise<RealtimeDataSample[]>;
  confirmRealtimeDataDrain(count: number): void;
  addConnectionStateListener(
    callback: (event: { state: string; peripheralId?: string; error?: string }) => void,
  ): { remove(): void };
  disconnect(): void;
}

/** tRPC client interface for BLE realtime data upload (beat interval + orientation + optical) */
export interface WhoopBleRealtimeUploadClient {
  whoopBleSync: {
    pushRealtimeData: {
      mutate(input: {
        deviceId: string;
        samples: Array<{
          timestamp: string;
          rrIntervalMs: number;
          quaternionW: number;
          quaternionX: number;
          quaternionY: number;
          quaternionZ: number;
          opticalRawHex: string;
        }>;
      }): Promise<{ inserted: number }>;
    };
  };
}

let appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;
let connectionStateSubscription: { remove(): void } | null = null;
let periodicDrainTimer: ReturnType<typeof setInterval> | null = null;
let syncing = false;
let connected = false;
let currentDeps: WhoopBleSyncDeps | null = null;
let currentRealtimeClient: WhoopBleRealtimeUploadClient | null = null;

/**
 * Initialize always-on WHOOP BLE accelerometer sync.
 *
 * - Connects to the WHOOP strap and starts IMU streaming while the app is active
 * - On subsequent foreground events, uploads buffered samples (streaming stays on)
 * - Should be called once after authentication when the setting is enabled
 */
export async function initBackgroundWhoopBleSync(
  trpcClient: InertialMeasurementUnitUploadClient,
  whoopDeps: WhoopBleSyncDeps,
  realtimeClient?: WhoopBleRealtimeUploadClient,
): Promise<void> {
  currentDeps = whoopDeps;
  currentRealtimeClient = realtimeClient ?? null;

  // Clean up existing listeners
  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
  }
  if (connectionStateSubscription) {
    connectionStateSubscription.remove();
    connectionStateSubscription = null;
  }
  stopPeriodicDrainTimer();

  // Listen for native BLE disconnects so we re-establish on next sync cycle.
  // Without this, the TS `connected` flag stays true after a disconnect
  // and the sync loop never attempts reconnection.
  connectionStateSubscription = whoopDeps.addConnectionStateListener((event) => {
    if (event.state === "disconnected") {
      logger.info(LOG_CATEGORY, `BLE disconnected (${event.error ?? "no error"}), will reconnect`);
      connected = false;
    } else if (event.state === "connected") {
      logger.info(LOG_CATEGORY, "BLE reconnected");
      connected = true;
    }
  });

  // Sync whenever the app comes to foreground
  appStateSubscription = AppState.addEventListener("change", (nextState: AppStateStatus) => {
    if (nextState !== "active") {
      stopPeriodicDrainTimer();
      return;
    }
    startPeriodicDrainTimer(trpcClient, whoopDeps, realtimeClient);
    if (syncing) {
      logger.info(LOG_CATEGORY, "foreground sync skipped — already syncing");
      return;
    }

    logger.info(LOG_CATEGORY, "app foregrounded — starting sync");
    syncing = true;
    syncOnForeground(trpcClient, whoopDeps, realtimeClient, shouldRunForegroundPeriodicDrain)
      .catch((error: unknown) => {
        logger.error(LOG_CATEGORY, `foreground sync error: ${error}`);
        captureException(error, { source: "whoop-ble-foreground-sync" });
      })
      .finally(() => {
        syncing = false;
      });
  });

  // The AppState listener only fires on state transitions, so sync immediately
  // when init runs in the foreground. Defer a backgrounded initialization until
  // the next active transition so this foreground sync does not try to start a
  // BLE connection while the app is suspended.
  if (shouldRunForegroundPeriodicDrain()) {
    logger.info(LOG_CATEGORY, "initializing background sync");
    syncing = true;
    try {
      await syncOnForeground(
        trpcClient,
        whoopDeps,
        realtimeClient,
        shouldRunForegroundPeriodicDrain,
      );
      logger.info(LOG_CATEGORY, "initial sync complete");
    } catch (error: unknown) {
      logger.error(LOG_CATEGORY, `initial sync error: ${error}`);
      captureException(error, { source: "whoop-ble-init-sync" });
    } finally {
      syncing = false;
    }
  } else {
    logger.info(LOG_CATEGORY, "initial sync deferred until app foregrounds");
  }

  // Periodically drain the buffer while the app is active so samples
  // don't pile up waiting for a foreground transition.
  startPeriodicDrainTimer(trpcClient, whoopDeps, realtimeClient);
}

function shouldRunForegroundPeriodicDrain(): boolean {
  return AppState.currentState === "active";
}

function shouldAlwaysContinueUploading(): boolean {
  return true;
}

function stopPeriodicDrainTimer(): void {
  if (!periodicDrainTimer) return;

  clearInterval(periodicDrainTimer);
  periodicDrainTimer = null;
}

function startPeriodicDrainTimer(
  trpcClient: InertialMeasurementUnitUploadClient,
  whoopDeps: WhoopBleSyncDeps,
  realtimeClient?: WhoopBleRealtimeUploadClient,
): void {
  if (!shouldRunForegroundPeriodicDrain() || periodicDrainTimer) return;

  periodicDrainTimer = setInterval(() => {
    if (!shouldRunForegroundPeriodicDrain()) {
      stopPeriodicDrainTimer();
      return;
    }
    if (syncing || !connected) return;
    syncing = true;
    drainBuffer(trpcClient, whoopDeps, realtimeClient, shouldRunForegroundPeriodicDrain)
      .catch((error: unknown) => {
        logger.error(LOG_CATEGORY, `periodic drain error: ${error}`);
        captureException(error, { source: "whoop-ble-periodic-drain" });
      })
      .finally(() => {
        syncing = false;
      });
  }, PERIODIC_DRAIN_INTERVAL_MS);
}

/**
 * Run a single WHOOP BLE sync cycle: connect if needed, then upload buffered samples.
 *
 * Exported so that the background refresh handler can call this directly
 * (every ~15-30 min) without waiting for the user to open the app.
 * Errors are reported to telemetry and rethrown so the native background task
 * can record an unsuccessful refresh.
 */
export async function syncWhoopBle(
  trpcClient: InertialMeasurementUnitUploadClient,
  whoopDeps: WhoopBleSyncDeps,
  realtimeClient?: WhoopBleRealtimeUploadClient,
): Promise<void> {
  try {
    logger.info(LOG_CATEGORY, "background refresh — starting sync");
    await syncOnForeground(trpcClient, whoopDeps, realtimeClient);
    logger.info(LOG_CATEGORY, "background refresh — sync complete");
  } catch (error: unknown) {
    logger.error(LOG_CATEGORY, `background refresh sync error: ${error}`);
    captureException(error, { source: "whoop-ble-background-refresh" });
    throw error;
  }
}

async function syncOnForeground(
  trpcClient: InertialMeasurementUnitUploadClient,
  whoopDeps: WhoopBleSyncDeps,
  realtimeClient?: WhoopBleRealtimeUploadClient,
  shouldContinueUploading: ShouldContinueUploading = shouldAlwaysContinueUploading,
): Promise<void> {
  // Connect if not already connected.
  //
  // Note: we skip the isBluetoothAvailable() pre-check because it suffers
  // from a race condition on the very first call. The CBCentralManager is
  // created lazily by ensureCentralManager(), but state starts as .unknown
  // and transitions to .poweredOn asynchronously via a delegate callback.
  // So the first isBluetoothAvailable() call always returns false, aborting
  // the sync before findWhoop() can even run. Instead, we let findWhoop()
  // handle unavailable Bluetooth by returning null (it checks state internally
  // after the manager has had time to initialize).
  if (!shouldContinueUploading()) return;

  if (!connected) {
    logger.info(LOG_CATEGORY, "not connected, searching for WHOOP strap");
    const device = await whoopDeps.findWhoop();
    if (!device) {
      logger.warn(LOG_CATEGORY, "no WHOOP strap found");
      Sentry.addBreadcrumb({
        category: "whoop-ble",
        message: "No WHOOP strap found",
        level: "warning",
      });
      return;
    }
    if (!shouldContinueUploading()) return;

    const deviceLabel = device.name ?? device.id;
    logger.info(LOG_CATEGORY, `connecting to ${deviceLabel}`);
    Sentry.addBreadcrumb({
      category: "whoop-ble",
      message: `Connecting to ${deviceLabel}`,
      level: "info",
    });
    await whoopDeps.connect(device.id);
    if (!shouldContinueUploading()) {
      whoopDeps.disconnect();
      connected = false;
      return;
    }
    logger.info(LOG_CATEGORY, "connected, sending TOGGLE_IMU_MODE");
    // Send TOGGLE_IMU_MODE to keep IMU data flowing even when the WHOOP
    // app isn't actively syncing. R21 data also flows passively during
    // WHOOP app sync, but this ensures continuous capture regardless.
    try {
      await whoopDeps.startImuStreaming();
      logger.info(LOG_CATEGORY, "TOGGLE_IMU_MODE sent");
    } catch (error: unknown) {
      captureException(error, { source: "whoop-ble-start-streaming" });
      // Best-effort — passive data may still flow without the command
      logger.warn(LOG_CATEGORY, `startImuStreaming failed (passive data may still work): ${error}`);
    }
    if (!shouldContinueUploading()) {
      whoopDeps.disconnect();
      connected = false;
      return;
    }
    connected = true;
    logger.info(LOG_CATEGORY, "listening for IMU data");
    Sentry.addBreadcrumb({
      category: "whoop-ble",
      message: "Connected and streaming",
      level: "info",
    });
  } else {
    logger.info(LOG_CATEGORY, "already connected, uploading buffer");
  }

  // Log data path stats for debugging (exposed from native module)
  try {
    // Dynamic import to avoid coupling the interface to diagnostic functions
    const bleModule = require("../modules/whoop-ble");
    if (typeof bleModule.getDataPathStats === "function") {
      const stats = bleModule.getDataPathStats();
      logger.info(LOG_CATEGORY, `data path stats: ${JSON.stringify(stats)}`);
    }
  } catch (error: unknown) {
    captureException(error, { source: "whoop-ble-data-path-stats-connect" });
  }

  await drainBuffer(trpcClient, whoopDeps, realtimeClient, shouldContinueUploading);
}

/**
 * Drain the native sample buffers and upload to the server.
 * Pulls samples in small batches (1000) to avoid memory spikes
 * from serializing the entire buffer across the native bridge at once.
 */
async function drainBuffer(
  trpcClient: InertialMeasurementUnitUploadClient,
  whoopDeps: WhoopBleSyncDeps,
  realtimeClient?: WhoopBleRealtimeUploadClient,
  shouldContinueUploading: ShouldContinueUploading = shouldAlwaysContinueUploading,
): Promise<void> {
  const deviceErasureCutoff = await loadDeviceErasureCutoff();

  // Log data path stats on every drain for diagnostics
  try {
    const bleModule = require("../modules/whoop-ble");
    if (typeof bleModule.getDataPathStats === "function") {
      const stats = bleModule.getDataPathStats();
      if (stats.dataNotificationCount > 0) {
        logger.info(
          LOG_CATEGORY,
          `stats: packets=${stats.packetTypes} rtBuf=${stats.realtimeBufferCount ?? 0}`,
        );
      }
    }
  } catch (error) {
    captureException(error);
  }
  // Drain IMU buffer using peek-then-confirm: samples stay in the native
  // buffer until the server confirms receipt, preventing data loss on
  // network failures.
  let totalImuUploaded = 0;
  while (true) {
    const samples = await whoopDeps.peekBufferedSamples(IMU_UPLOAD_BATCH_SIZE);
    if (samples.length === 0) break;
    const uploadableSamples =
      deviceErasureCutoff === null
        ? samples
        : samples.filter((sample) =>
            isAfterDeviceErasureCutoff(sample.timestamp, deviceErasureCutoff),
          );

    let deviceIds = Array.from(
      new Set(
        uploadableSamples.map((sample) => sample.deviceId?.trim() || DEFAULT_WHOOP_DEVICE_ID),
      ),
    );
    let firstTimestamp: string | undefined;
    let lastTimestamp: string | undefined;

    try {
      const groups = new DeviceSampleGroups(
        DEFAULT_WHOOP_DEVICE_ID,
        toInertialMeasurementUnitUploadSample,
      );
      for (const sample of uploadableSamples) {
        groups.add(sample);
      }
      deviceIds = [...groups.entries()].map(([deviceId]) => deviceId);
      firstTimestamp = samples[0]?.timestamp;
      lastTimestamp = samples[samples.length - 1]?.timestamp;

      let inserted = 0;
      for (const [deviceId, uploadSamples] of groups.entries()) {
        if (!shouldContinueUploading()) {
          logger.info(LOG_CATEGORY, "IMU upload skipped — app is no longer active");
          return;
        }
        const result = await trpcClient.inertialMeasurementUnitSync.pushSamples.mutate({
          deviceId,
          deviceType: "whoop",
          samples: uploadSamples,
        });
        inserted += result.inserted;
      }
      whoopDeps.confirmSamplesDrain(samples.length);
      totalImuUploaded += samples.length;
      logger.info(
        LOG_CATEGORY,
        `uploaded ${samples.length} IMU samples (server inserted: ${inserted})`,
      );
    } catch (error: unknown) {
      logger.error(LOG_CATEGORY, `IMU upload failed, ${samples.length} samples retained: ${error}`);
      captureException(error, {
        source: "whoop-ble-imu-upload",
        bufferedSampleCount: samples.length,
        deviceCount: deviceIds.length,
        deviceIds,
        firstTimestamp: firstTimestamp ?? samples[0]?.timestamp,
        lastTimestamp: lastTimestamp ?? samples[samples.length - 1]?.timestamp,
      });
      break; // Stop draining — samples are still in the buffer for retry
    }
  }

  if (totalImuUploaded > 0) {
    logger.info(LOG_CATEGORY, `IMU drain complete: ${totalImuUploaded} samples`);
  }

  // Drain realtime data buffer (beat interval + quaternion + optical from 0x28 packets)
  const effectiveRealtimeClient = realtimeClient ?? currentRealtimeClient;
  if (effectiveRealtimeClient) {
    let totalRealtimeUploaded = 0;
    while (true) {
      const realtimeSamples = await whoopDeps.peekBufferedRealtimeData(REALTIME_UPLOAD_BATCH_SIZE);
      logger.info(LOG_CATEGORY, `realtime buffer: ${realtimeSamples.length} samples`);
      if (realtimeSamples.length === 0) break;
      const uploadableRealtimeSamples =
        deviceErasureCutoff === null
          ? realtimeSamples
          : realtimeSamples.filter((sample) =>
              isAfterDeviceErasureCutoff(sample.timestamp, deviceErasureCutoff),
            );

      try {
        const groups = new DeviceSampleGroups(DEFAULT_WHOOP_DEVICE_ID, toRealtimeDataUploadSample);
        for (const sample of uploadableRealtimeSamples) {
          groups.add(sample);
        }

        let inserted = 0;
        for (const [deviceId, uploadSamples] of groups.entries()) {
          if (!shouldContinueUploading()) {
            logger.info(LOG_CATEGORY, "realtime upload skipped — app is no longer active");
            return;
          }
          const result = await effectiveRealtimeClient.whoopBleSync.pushRealtimeData.mutate({
            deviceId,
            samples: uploadSamples,
          });
          inserted += result.inserted;
        }
        whoopDeps.confirmRealtimeDataDrain(realtimeSamples.length);
        totalRealtimeUploaded += realtimeSamples.length;
        logger.info(
          LOG_CATEGORY,
          `uploaded ${realtimeSamples.length} realtime samples (server inserted: ${inserted})`,
        );
      } catch (error: unknown) {
        logger.error(
          LOG_CATEGORY,
          `realtime upload failed, ${realtimeSamples.length} samples retained: ${error}`,
        );
        captureException(error, { source: "whoop-ble-realtime-upload" });
        break;
      }
    }

    if (totalRealtimeUploaded > 0) {
      logger.info(LOG_CATEGORY, `realtime drain complete: ${totalRealtimeUploaded} samples`);
    }
  }
}

/** Clean up background WHOOP BLE sync listeners and disconnect */
export function teardownBackgroundWhoopBleSync(): void {
  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
  }

  if (connectionStateSubscription) {
    connectionStateSubscription.remove();
    connectionStateSubscription = null;
  }

  if (periodicDrainTimer) {
    clearInterval(periodicDrainTimer);
    periodicDrainTimer = null;
  }

  if (connected && currentDeps) {
    try {
      currentDeps.stopImuStreaming().catch((error: unknown) => {
        captureException(error, { source: "whoop-ble-teardown" });
      });
    } catch (error: unknown) {
      captureException(error, { source: "whoop-ble-teardown-sync" });
      // Best-effort cleanup
    }
    currentDeps.disconnect();
  }

  connected = false;
  currentDeps = null;
  currentRealtimeClient = null;
  syncing = false;
}
