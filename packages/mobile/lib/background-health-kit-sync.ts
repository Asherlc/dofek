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
import { syncHealthKitToServer, type SyncTrpcClient } from "./health-kit-sync";
import { captureException } from "./telemetry";

const TAG = "[bg-healthkit-sync]";
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
    console.log(`${TAG} HealthKit not available, skipping init`);
    return;
  }

  const status = await getRequestStatus();
  if (status !== "unnecessary") {
    console.log(`${TAG} HealthKit permission status="${status}", skipping init`);
    return;
  }

  // Set up native observer queries
  await setupBackgroundObservers();
  console.log(`${TAG} Background observers registered`);

  // Clean up any existing listener
  if (subscription) {
    console.log(`${TAG} Removing previous listener before re-init`);
    subscription.remove();
    subscription = null;
  }

  // Listen for sample update events and debounce into a single sync
  subscription = addSampleUpdateListener(() => {
    console.log(`${TAG} Sample update event received, debouncing`);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (syncing) {
        console.log(`${TAG} Sync already in progress, skipping`);
        return;
      }
      syncing = true;
      console.log(`${TAG} Starting sync`);
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
          console.log(
            `${TAG} Sync complete: ${result.inserted} inserted, ${result.errors.length} errors`,
          );
          onSyncComplete?.();
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`${TAG} Sync failed: ${message}`);
          captureException(error, { source: "background-health-kit-sync" });
        })
        .finally(() => {
          syncing = false;
        });
    }, DEBOUNCE_MS);
  });

  console.log(`${TAG} Init complete, listening for HealthKit updates`);
}

/** Clean up background sync listeners and timers */
export function teardownBackgroundHealthKitSync() {
  if (subscription) {
    console.log(`${TAG} Tearing down: removing listener`);
    subscription.remove();
    subscription = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}
