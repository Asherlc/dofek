import * as Sentry from "@sentry/react-native";
import { AppState, type AppStateStatus } from "react-native";
import type { InertialMeasurementUnitUploadClient } from "./inertial-measurement-unit-service";
import { captureException, logger } from "./telemetry";

const UPLOAD_BATCH_SIZE = 5000;
const PERIODIC_DRAIN_INTERVAL_MS = 30_000; // Upload buffered samples every 30s
const LOG_CATEGORY = "whoop-ble";

/** Dependencies injected for testability (wraps the whoop-ble native module) */
export interface WhoopBleSyncDeps {
  isBluetoothAvailable(): boolean;
  findWhoop(): Promise<{ id: string; name: string | null } | null>;
  connect(peripheralId: string): Promise<boolean>;
  startImuStreaming(): Promise<boolean>;
  stopImuStreaming(): Promise<boolean>;
  getBufferedSamples(): Promise<
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
  disconnect(): void;
}

let appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;
let periodicDrainTimer: ReturnType<typeof setInterval> | null = null;
let syncing = false;
let connected = false;
let currentDeps: WhoopBleSyncDeps | null = null;

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
): Promise<void> {
  currentDeps = whoopDeps;

  // Clean up existing listener
  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
  }

  // Sync whenever the app comes to foreground
  appStateSubscription = AppState.addEventListener("change", (nextState: AppStateStatus) => {
    if (nextState !== "active") return;
    if (syncing) {
      logger.info(LOG_CATEGORY, "foreground sync skipped — already syncing");
      return;
    }

    logger.info(LOG_CATEGORY, "app foregrounded — starting sync");
    syncing = true;
    syncOnForeground(trpcClient, whoopDeps)
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
    await syncOnForeground(trpcClient, whoopDeps);
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
    drainBuffer(trpcClient, whoopDeps)
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
): Promise<void> {
  try {
    logger.info(LOG_CATEGORY, "background refresh — starting sync");
    await syncOnForeground(trpcClient, whoopDeps);
    logger.info(LOG_CATEGORY, "background refresh — sync complete");
  } catch (error: unknown) {
    logger.error(LOG_CATEGORY, `background refresh sync error: ${error}`);
    Sentry.captureException(error, { tags: { source: "whoop-ble-background-refresh" } });
  }
}

async function syncOnForeground(
  trpcClient: InertialMeasurementUnitUploadClient,
  whoopDeps: WhoopBleSyncDeps,
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

  await drainBuffer(trpcClient, whoopDeps);
}

/**
 * Drain the native sample buffer and upload to the server.
 * Pulls samples in small batches (1000) to avoid memory spikes
 * from serializing the entire buffer across the native bridge at once.
 */
async function drainBuffer(
  trpcClient: InertialMeasurementUnitUploadClient,
  whoopDeps: WhoopBleSyncDeps,
): Promise<void> {
  let totalUploaded = 0;

  // Pull 1000 samples at a time from the native buffer
  // to keep bridge serialization memory low
  while (true) {
    const samples = await whoopDeps.getBufferedSamples();
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

    const result = await trpcClient.inertialMeasurementUnitSync.pushSamples.mutate({
      deviceId: "WHOOP Strap",
      deviceType: "whoop",
      samples: uploadSamples,
    });
    totalUploaded += uploadSamples.length;
    logger.info(
      LOG_CATEGORY,
      `uploaded ${uploadSamples.length} samples (server inserted: ${result.inserted})`,
    );
  }

  if (totalUploaded > 0) {
    logger.info(LOG_CATEGORY, `drain complete: ${totalUploaded} samples`);
  }
}

/** Clean up background WHOOP BLE sync listeners and disconnect */
export function teardownBackgroundWhoopBleSync(): void {
  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
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
  syncing = false;
}
