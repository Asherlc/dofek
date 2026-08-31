import { AppState, type AppStateStatus } from "react-native";
import {
  enableAccountSync,
  isWatchAppInstalled,
  isWatchPaired,
  requestWatchRecording,
} from "./platform-native/watch";
import type { InertialMeasurementUnitSyncTrpcClient } from "./inertial-measurement-unit-sync";
import { captureException, logger } from "./telemetry";
import {
  syncWatchAltitudeFiles,
  type WatchAltitudeSyncTrpcClient,
} from "./watch-altitude-file-sync";
import { syncWatchAccelerometerFiles } from "./watch-file-sync";

const TAG = "bg-watch-sync";

export interface WatchSyncTrpcClient
  extends InertialMeasurementUnitSyncTrpcClient,
    WatchAltitudeSyncTrpcClient {}

/** Build the narrowed tRPC client used by background Watch sync helpers. */
export function createWatchSyncClient(trpcClient: WatchSyncTrpcClient): WatchSyncTrpcClient {
  return {
    inertialMeasurementUnitSync: {
      pushSamples: {
        mutate: (input) => trpcClient.inertialMeasurementUnitSync.pushSamples.mutate(input),
      },
    },
    watchAltitudeSync: {
      pushSamples: {
        mutate: (input) => trpcClient.watchAltitudeSync.pushSamples.mutate(input),
      },
    },
  };
}

let appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;
let syncChain: Promise<void> = Promise.resolve();

/**
 * Initialize background Apple Watch IMU sync.
 *
 * - Checks if a Watch is paired with the Dofek app installed
 * - Listens for app foreground events and syncs any pending transferred data
 * - Runs an initial sync immediately (AppState listener only fires on transitions)
 * - Should be called once after authentication is established
 *
 * Uses per-file sync: each Watch transfer file is processed independently,
 * so a failure in one file does not block others from being uploaded and
 * acknowledged.
 */
export async function initBackgroundWatchInertialMeasurementUnitSync(
  trpcClient: WatchSyncTrpcClient,
): Promise<void> {
  const paired = isWatchPaired();
  const installed = isWatchAppInstalled();
  logger.info(TAG, `init: paired=${paired}, appInstalled=${installed}`);

  if (!paired || !installed) return;
  await enableAccountSync();

  // Clean up existing listener
  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
  }

  // Sync whenever the app comes to foreground. Chain promises so rapid AppState
  // transitions cannot overlap sync work on the same client.
  appStateSubscription = AppState.addEventListener("change", (nextState: AppStateStatus) => {
    logger.info(TAG, `AppState changed to: ${nextState}`);
    if (nextState !== "active") return;

    syncChain = syncChain
      .then(() => syncAndRecord(trpcClient))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(TAG, `sync failed: ${message}`);
        captureException(error, { source: TAG });
      });
  });

  // Run an initial sync immediately. The app is already active when init runs,
  // so no AppState "active" event fires until the next background -> foreground cycle.
  logger.info(TAG, "Running initial sync");
  await syncAndRecord(trpcClient);
  logger.info(TAG, "Initial sync complete");
}

/**
 * Sync pending Watch files and request the Watch to continue recording.
 */
async function syncAndRecord(trpcClient: WatchSyncTrpcClient): Promise<void> {
  try {
    await syncWatchAccelerometerFiles(trpcClient);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(TAG, `Accelerometer sync failed: ${message}`);
    captureException(error instanceof Error ? error : new Error(message), {
      source: `${TAG}:accelerometer`,
    });
  }

  try {
    await syncWatchAltitudeFiles(trpcClient);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(TAG, `Altitude sync failed: ${message}`);
    captureException(error instanceof Error ? error : new Error(message), {
      source: `${TAG}:altitude`,
    });
  }

  // Ask the Watch to restart recording and send any new data
  try {
    await requestWatchRecording();
  } catch (error: unknown) {
    captureException(error, { source: `${TAG}:request-recording` });
    // Best-effort — Watch may not be reachable
  }
}

/** Clean up background Watch IMU sync listeners. */
export function teardownBackgroundWatchInertialMeasurementUnitSync(): void {
  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
  }
}
