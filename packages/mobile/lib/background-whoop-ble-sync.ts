import * as Sentry from "@sentry/react-native";
import { AppState, type AppStateStatus } from "react-native";
import type { InertialMeasurementUnitUploadClient } from "./inertial-measurement-unit-service";
import { captureException, logger } from "./telemetry";

const UPLOAD_BATCH_SIZE = 5000;
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
}

async function syncOnForeground(
  trpcClient: InertialMeasurementUnitUploadClient,
  whoopDeps: WhoopBleSyncDeps,
): Promise<void> {
  if (!whoopDeps.isBluetoothAvailable()) {
    logger.warn(LOG_CATEGORY, "Bluetooth not available, skipping sync");
    Sentry.addBreadcrumb({
      category: "whoop-ble",
      message: "Bluetooth not available, skipping sync",
      level: "warning",
    });
    return;
  }

  // Connect if not already connected
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
    logger.info(LOG_CATEGORY, "connected, starting IMU streaming");
    await whoopDeps.startImuStreaming();
    connected = true;
    logger.info(LOG_CATEGORY, "streaming started");
    Sentry.addBreadcrumb({
      category: "whoop-ble",
      message: "Connected and streaming",
      level: "info",
    });
  } else {
    logger.info(LOG_CATEGORY, "already connected, uploading buffer");
  }

  // Upload any buffered samples
  const samples = await whoopDeps.getBufferedSamples();
  logger.info(LOG_CATEGORY, `getBufferedSamples returned ${samples.length} samples`);

  if (samples.length === 0) {
    Sentry.addBreadcrumb({
      category: "whoop-ble",
      message: "Buffer empty — no samples to upload",
      level: "info",
    });
    return;
  }

  // Convert to the IMU sample format (accel + gyro) for the upload endpoint
  const uploadSamples = samples.map((sample) => ({
    timestamp: sample.timestamp,
    x: sample.accelerometerX,
    y: sample.accelerometerY,
    z: sample.accelerometerZ,
    gyroscopeX: sample.gyroscopeX,
    gyroscopeY: sample.gyroscopeY,
    gyroscopeZ: sample.gyroscopeZ,
  }));

  // Log timestamp range for debugging stale/future data
  const firstTimestamp = uploadSamples[0]?.timestamp;
  const lastTimestamp = uploadSamples[uploadSamples.length - 1]?.timestamp;
  logger.info(
    LOG_CATEGORY,
    `uploading ${uploadSamples.length} samples (${firstTimestamp} → ${lastTimestamp})`,
  );

  let totalUploaded = 0;
  for (let offset = 0; offset < uploadSamples.length; offset += UPLOAD_BATCH_SIZE) {
    const batch = uploadSamples.slice(offset, offset + UPLOAD_BATCH_SIZE);
    const result = await trpcClient.inertialMeasurementUnitSync.pushSamples.mutate({
      deviceId: "WHOOP Strap",
      deviceType: "whoop",
      samples: batch,
    });
    totalUploaded += batch.length;
    logger.info(
      LOG_CATEGORY,
      `uploaded batch ${Math.floor(offset / UPLOAD_BATCH_SIZE) + 1}: ${batch.length} samples (server inserted: ${result.inserted})`,
    );
  }
  logger.info(LOG_CATEGORY, `upload complete: ${totalUploaded} samples`);
}

/** Clean up background WHOOP BLE sync listeners and disconnect */
export function teardownBackgroundWhoopBleSync(): void {
  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
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
    connected = false;
  }

  currentDeps = null;
  syncing = false;
}
