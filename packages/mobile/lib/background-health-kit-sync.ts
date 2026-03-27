import type { EventSubscription } from "expo-modules-core";
import {
  addSampleUpdateListener,
  getRequestStatus,
  isAvailable,
  queryDailyStatistics,
  queryQuantitySamples,
  querySleepSamples,
  queryWorkouts,
  setupBackgroundObservers,
} from "../modules/health-kit";
import { type SyncTrpcClient, syncHealthKitToServer } from "./health-kit-sync";
import { captureException, logger } from "./telemetry";

const TAG = "bg-healthkit-sync";
const DEBOUNCE_MS = 5000;

let subscription: EventSubscription | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let syncing = false;

/**
 * Initialize background HealthKit sync.
 * Sets up observer queries that fire when new health samples arrive,
 * then debounces and syncs the last 24 hours of data to the server.
 *
 * Call this once after authentication is established.
 */
export async function initBackgroundHealthKitSync(
  trpcClient: SyncTrpcClient,
  onSyncComplete?: () => void,
) {
  if (!isAvailable()) {
    logger.info(TAG, "HealthKit not available, skipping init");
    return;
  }

  const status = await getRequestStatus();
  if (status !== "unnecessary") {
    logger.info(TAG, `HealthKit permission status="${status}", skipping init`);
    return;
  }

  // Set up native observer queries
  await setupBackgroundObservers();
  logger.info(TAG, "Background observers registered");

  // Clean up any existing listener
  if (subscription) {
    logger.info(TAG, "Removing previous listener before re-init");
    subscription.remove();
    subscription = null;
  }

  // Listen for sample update events and debounce into a single sync
  subscription = addSampleUpdateListener(() => {
    logger.info(TAG, "Sample update event received, debouncing");
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (syncing) {
        logger.info(TAG, "Sync already in progress, skipping");
        return;
      }
      syncing = true;
      logger.info(TAG, "Starting sync");
      syncHealthKitToServer({
        trpcClient,
        healthKit: {
          queryDailyStatistics,
          queryQuantitySamples,
          queryWorkouts,
          querySleepSamples,
        },
        syncRangeDays: 1,
      })
        .then((result) => {
          logger.info(
            TAG,
            `Sync complete: ${result.inserted} inserted, ${result.errors.length} errors`,
          );
          onSyncComplete?.();
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(TAG, `Sync failed: ${message}`);
          captureException(error, { source: TAG });
        })
        .finally(() => {
          syncing = false;
        });
    }, DEBOUNCE_MS);
  });

  logger.info(TAG, "Init complete, listening for HealthKit updates");
}

/** Clean up background sync listeners and timers */
export function teardownBackgroundHealthKitSync() {
  if (subscription) {
    logger.info(TAG, "Tearing down: removing listener");
    subscription.remove();
    subscription = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}
