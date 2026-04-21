import type { EventSubscription } from "expo-modules-core";
import {
  addSampleUpdateListener,
  hasEverAuthorized,
  isAvailable,
  queryDailyStatistics,
  queryQuantitySamples,
  querySleepSamples,
  queryWorkoutRoutes,
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

  if (!hasEverAuthorized()) {
    logger.info(TAG, "HealthKit never authorized, skipping init");
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
          queryWorkoutRoutes,
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
          // "Protected health data is inaccessible" fires when the device is
          // locked — HealthKit encrypts data at rest. This is a known transient
          // condition (the next foreground event will succeed), not an actionable
          // error, so log it but don't send to telemetry.
          if (message.includes("Protected health data is inaccessible")) {
            logger.info(TAG, "Device locked, skipping sync");
            return;
          }
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
