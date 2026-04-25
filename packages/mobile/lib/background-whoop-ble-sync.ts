import * as Sentry from "@sentry/react-native";
import { AppState, type AppStateStatus } from "react-native";
import type { InertialMeasurementUnitUploadClient } from "./inertial-measurement-unit-service";
import { captureException, logger } from "./telemetry";

const PERIODIC_DRAIN_INTERVAL_MS = 30_000; // Upload buffered samples every 30s
const LOG_CATEGORY = "whoop-ble";

/** Dependencies injected for testability (wraps the whoop-ble native module) */
export interface WhoopBleSyncDeps {
  isBluetoothAvailable(): boolean;
  findWhoop(): Promise<{ id: string; name: string | null } | null>;
  connect(peripheralId: string): Promise<boolean>;
  startImuStreaming(): Promise<boolean>;
  stopImuStreaming(): Promise<boolean>;
  peekBufferedSamples(): Promise<
    Array<{
      timestamp: string;
      accelerometerX: number;
      accelerometerY: number;
      accelerometerZ: number;
      gyroscopeX: number;
      gyroscopeY: number;
      gyroscopeZ: number;
    }>
  >;
  confirmSamplesDrain(count: number): void;
  peekBufferedRealtimeData(): Promise<
    Array<{
      timestamp: string;
      rrIntervalMs: number;
      quaternionW: number;
      quaternionX: number;
      quaternionY: number;
      quaternionZ: number;
      opticalRawHex: string;
    }>
  >;
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
 * - Connects to the WHOOP strap and starts IMU streaming immediately
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
    if (nextState !== "active") return;
    if (syncing) {
      logger.info(LOG_CATEGORY, "foreground sync skipped — already syncing");
      return;
    }

    logger.info(LOG_CATEGORY, "app foregrounded — starting sync");
    syncing = true;
    syncOnForeground(trpcClient, whoopDeps, realtimeClient)
      .catch((error: unknown) => {
        logger.error(LOG_CATEGORY, `foreground sync error: ${error}`);
        Sentry.captureException(error, { tags: { source: "whoop-ble-foreground-sync" } });
      })
      .finally(() => {
        syncing = false;
      });
  });

  // Do an initial sync immediately — the AppState listener only fires on
  // state *transitions*, so if the app is already active when init is called
  // (the common case), nothing would happen until the user backgrounds and
  // re-opens the app. Best-effort: don't let init failures propagate.
  logger.info(LOG_CATEGORY, "initializing background sync");
  try {
    await syncOnForeground(trpcClient, whoopDeps, realtimeClient);
    logger.info(LOG_CATEGORY, "initial sync complete");
  } catch (error: unknown) {
    logger.error(LOG_CATEGORY, `initial sync error: ${error}`);
    Sentry.captureException(error, { tags: { source: "whoop-ble-init-sync" } });
  }

  // Periodically drain the buffer while the app is active so samples
  // don't pile up waiting for a foreground transition.
  if (periodicDrainTimer) {
    clearInterval(periodicDrainTimer);
  }
  periodicDrainTimer = setInterval(() => {
    if (syncing || !connected) return;
    syncing = true;
    drainBuffer(trpcClient, whoopDeps, realtimeClient)
      .catch((error: unknown) => {
        logger.error(LOG_CATEGORY, `periodic drain error: ${error}`);
        Sentry.captureException(error, { tags: { source: "whoop-ble-periodic-drain" } });
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
 * Errors are caught and reported to telemetry — never throws.
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
    Sentry.captureException(error, { tags: { source: "whoop-ble-background-refresh" } });
  }
}

async function syncOnForeground(
  trpcClient: InertialMeasurementUnitUploadClient,
  whoopDeps: WhoopBleSyncDeps,
  realtimeClient?: WhoopBleRealtimeUploadClient,
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

    const deviceLabel = device.name ?? device.id;
    logger.info(LOG_CATEGORY, `connecting to ${deviceLabel}`);
    Sentry.addBreadcrumb({
      category: "whoop-ble",
      message: `Connecting to ${deviceLabel}`,
      level: "info",
    });
    await whoopDeps.connect(device.id);
    logger.info(LOG_CATEGORY, "connected, sending TOGGLE_IMU_MODE");
    // Send TOGGLE_IMU_MODE to keep IMU data flowing even when the WHOOP
    // app isn't actively syncing. R21 data also flows passively during
    // WHOOP app sync, but this ensures continuous capture regardless.
    try {
      await whoopDeps.startImuStreaming();
      logger.info(LOG_CATEGORY, "TOGGLE_IMU_MODE sent");
    } catch (error: unknown) {
      // Best-effort — passive data may still flow without the command
      logger.warn(LOG_CATEGORY, `startImuStreaming failed (passive data may still work): ${error}`);
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
  } catch {
    // Diagnostic-only, ignore errors
  }

  await drainBuffer(trpcClient, whoopDeps, realtimeClient);
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
): Promise<void> {
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
    const samples = await whoopDeps.peekBufferedSamples();
    if (samples.length === 0) break;

    const uploadSamples = samples.map((sample) => ({
      timestamp: sample.timestamp,
      x: sample.accelerometerX,
      y: sample.accelerometerY,
      z: sample.accelerometerZ,
      gyroscopeX: sample.gyroscopeX,
      gyroscopeY: sample.gyroscopeY,
      gyroscopeZ: sample.gyroscopeZ,
    }));

    try {
      const result = await trpcClient.inertialMeasurementUnitSync.pushSamples.mutate({
        deviceId: "WHOOP Strap",
        deviceType: "whoop",
        samples: uploadSamples,
      });
      whoopDeps.confirmSamplesDrain(samples.length);
      totalImuUploaded += uploadSamples.length;
      logger.info(
        LOG_CATEGORY,
        `uploaded ${uploadSamples.length} IMU samples (server inserted: ${result.inserted})`,
      );
    } catch (error: unknown) {
      logger.error(LOG_CATEGORY, `IMU upload failed, ${samples.length} samples retained: ${error}`);
      captureException(error, { source: "whoop-ble-imu-upload" });
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
      const realtimeSamples = await whoopDeps.peekBufferedRealtimeData();
      logger.info(LOG_CATEGORY, `realtime buffer: ${realtimeSamples.length} samples`);
      if (realtimeSamples.length === 0) break;

      try {
        const uploadSamples = realtimeSamples.map((sample) => ({
          timestamp: sample.timestamp,
          rrIntervalMs: sample.rrIntervalMs,
          quaternionW: sample.quaternionW,
          quaternionX: sample.quaternionX,
          quaternionY: sample.quaternionY,
          quaternionZ: sample.quaternionZ,
          opticalRawHex: sample.opticalRawHex,
        }));
        const result = await effectiveRealtimeClient.whoopBleSync.pushRealtimeData.mutate({
          deviceId: "WHOOP Strap",
          samples: uploadSamples,
        });
        whoopDeps.confirmRealtimeDataDrain(realtimeSamples.length);
        totalRealtimeUploaded += realtimeSamples.length;
        logger.info(
          LOG_CATEGORY,
          `uploaded ${realtimeSamples.length} realtime samples (server inserted: ${result.inserted})`,
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
    } catch {
      // Best-effort cleanup
    }
    currentDeps.disconnect();
  }

  connected = false;
  currentDeps = null;
  currentRealtimeClient = null;
  syncing = false;
}
