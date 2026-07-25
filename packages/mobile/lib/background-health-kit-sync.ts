import type { EventSubscription } from "expo-modules-core";
import {
  addSampleUpdateListener,
  completeBackgroundDelivery,
  setupBackgroundObservers,
  teardownBackgroundObservers,
} from "../modules/health-kit";
import { AppleHealthAuthorizationService, AppleHealthSyncService } from "./apple-health-provider";
import type { SyncTrpcClient } from "./health-kit-sync";
import { captureException, logger } from "./telemetry";

const TAG = "bg-healthkit-sync";
const DEBOUNCE_MS = 5000;
const HEALTHKIT_DATABASE_INACCESSIBLE_CODE = "HEALTHKIT_DATABASE_INACCESSIBLE";

let subscription: EventSubscription | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let syncing = false;
let syncRequested = false;
let lifecycleGeneration = 0;
const pendingDeliveryIds = new Set<string>();

function isHealthKitDatabaseInaccessible(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === HEALTHKIT_DATABASE_INACCESSIBLE_CODE
  );
}

function takePendingDeliveryIds(): string[] {
  const deliveryIds = [...pendingDeliveryIds];
  pendingDeliveryIds.clear();
  return deliveryIds;
}

function acknowledgeDeliveries(deliveryIds: string[]) {
  for (const deliveryId of deliveryIds) {
    try {
      completeBackgroundDelivery(deliveryId);
    } catch (error: unknown) {
      captureException(error, {
        source: "bg-healthkit-delivery-completion",
        deliveryId,
      });
    }
  }
}

function startHealthKitSync(
  trpcClient: SyncTrpcClient,
  onSyncComplete?: () => void,
  includePendingDeliveries = false,
) {
  if (syncing) {
    if (includePendingDeliveries && pendingDeliveryIds.size > 0) {
      syncRequested = true;
      logger.info(TAG, "Sync already in progress, follow-up queued");
      return;
    }
    logger.info(TAG, "Sync already in progress, skipping");
    return;
  }

  const generation = lifecycleGeneration;
  const deliveryIds = includePendingDeliveries ? takePendingDeliveryIds() : [];
  syncing = true;
  logger.info(TAG, "Starting sync");
  new AppleHealthSyncService({ trpcClient })
    .sync({ syncRangeDays: 1 })
    .then((result) => {
      logger.info(
        TAG,
        `Sync complete: ${result.inserted} inserted, ${result.errors.length} errors`,
      );
      onSyncComplete?.();
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // HealthKit encrypts data at rest while the device is locked. This is a
      // known transient condition (the next foreground event will succeed),
      // not an actionable error, so log it but don't send it to Sentry.
      if (isHealthKitDatabaseInaccessible(error)) {
        logger.info(TAG, "Device locked, skipping sync");
        return;
      }
      logger.warn(TAG, `Sync failed: ${message}`);
      captureException(error, { source: TAG });
    })
    .finally(() => {
      acknowledgeDeliveries(deliveryIds);
      if (generation !== lifecycleGeneration) {
        return;
      }
      syncing = false;
      if (syncRequested) {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        syncRequested = false;
        startHealthKitSync(trpcClient, onSyncComplete, true);
      }
    });
}

function resetBackgroundObserverLifecycle() {
  lifecycleGeneration++;
  syncing = false;
  syncRequested = false;

  if (subscription) {
    logger.info(TAG, "Tearing down: removing listener");
    subscription.remove();
    subscription = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  acknowledgeDeliveries(takePendingDeliveryIds());
  teardownBackgroundObservers();
}

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
  resetBackgroundObserverLifecycle();
  const authorizationState = await new AppleHealthAuthorizationService().resolve();
  if (!authorizationState.canAttemptSync()) {
    logger.info(TAG, "HealthKit not available, skipping init");
    return;
  }

  // Register JavaScript before starting native queries because HealthKit can
  // deliver an observer update immediately when the query starts.
  subscription = addSampleUpdateListener(({ deliveryId }) => {
    pendingDeliveryIds.add(deliveryId);
    logger.info(TAG, "Sample update event received, debouncing");
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      startHealthKitSync(trpcClient, onSyncComplete, true);
    }, DEBOUNCE_MS);
  });

  await setupBackgroundObservers();
  logger.info(TAG, "Background observers registered");
  startHealthKitSync(trpcClient, onSyncComplete);

  logger.info(TAG, "Init complete, listening for HealthKit updates");
}

/** Clean up background sync listeners and timers */
export function teardownBackgroundHealthKitSync() {
  resetBackgroundObserverLifecycle();
}
