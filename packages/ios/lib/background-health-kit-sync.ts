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
  if (!isAvailable()) return;

  const status = await getRequestStatus();
  if (status !== "unnecessary") return;

  // Set up native observer queries
  await setupBackgroundObservers();

  // Clean up any existing listener
  if (subscription) {
    subscription.remove();
    subscription = null;
  }

  // Listen for sample update events and debounce into a single sync
  subscription = addSampleUpdateListener(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (syncing) return;
      syncing = true;
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
        .then(() => {
          onSyncComplete?.();
        })
        .catch(() => {
          // Best-effort — don't crash the app for background sync failures
        })
        .finally(() => {
          syncing = false;
        });
    }, DEBOUNCE_MS);
  });
}

/** Clean up background sync listeners and timers */
export function teardownBackgroundHealthKitSync() {
  if (subscription) {
    subscription.remove();
    subscription = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}
