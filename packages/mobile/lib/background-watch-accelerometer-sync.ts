import { AppState, type AppStateStatus } from "react-native";
import { isWatchAppInstalled, isWatchPaired, requestWatchRecording } from "../modules/watch-motion";
import type { AccelerometerSyncTrpcClient } from "./accelerometer-sync";
import { captureException, logger } from "./telemetry";
import { syncWatchAccelerometerFiles } from "./watch-file-sync";

const TAG = "bg-watch-accel-sync";

let appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;
let syncing = false;

/**
 * Initialize background Apple Watch accelerometer sync.
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
export async function initBackgroundWatchAccelerometerSync(
  trpcClient: AccelerometerSyncTrpcClient,
): Promise<void> {
  const paired = isWatchPaired();
  const installed = isWatchAppInstalled();
  logger.info(TAG, `init: paired=${paired}, appInstalled=${installed}`);

  if (!paired || !installed) return;

  // Clean up existing listener
  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
  }

  // Sync whenever the app comes to foreground
  appStateSubscription = AppState.addEventListener("change", (nextState: AppStateStatus) => {
    logger.info(TAG, `AppState changed to: ${nextState}, syncing=${syncing}`);
    if (nextState !== "active") return;
    if (syncing) return;

    syncing = true;
    syncAndRecord(trpcClient)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(TAG, `sync failed: ${message}`);
        captureException(error, { source: TAG });
      })
      .finally(() => {
        syncing = false;
      });
  });

  // Run an initial sync immediately. The app is already active when init runs,
  // so no AppState "active" event fires until the next background → foreground cycle.
  logger.info(TAG, "Running initial sync");
  await syncAndRecord(trpcClient);
  logger.info(TAG, "Initial sync complete");
}

/**
 * Sync pending Watch files and request the Watch to continue recording.
 */
async function syncAndRecord(trpcClient: AccelerometerSyncTrpcClient): Promise<void> {
  await syncWatchAccelerometerFiles(trpcClient);

  // Ask the Watch to restart recording and send any new data
  try {
    await requestWatchRecording();
  } catch {
    // Best-effort — Watch may not be reachable
  }
}

/** Clean up background Watch accelerometer sync listeners. */
export function teardownBackgroundWatchAccelerometerSync(): void {
  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
  }
}
