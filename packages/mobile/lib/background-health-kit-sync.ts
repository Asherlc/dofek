import type { EventSubscription } from "expo-modules-core";
import {
  addSampleUpdateListener,
  completeObserverUpdates,
  setupBackgroundObservers,
  teardownBackgroundObservers,
} from "../modules/health-kit";
import { AppleHealthAuthorizationService, AppleHealthSyncService } from "./apple-health-provider";
import type { HealthKitSyncStage, SyncTrpcClient } from "./health-kit-sync";
import { captureException, logger } from "./telemetry";

const TAG = "bg-healthkit-sync";
const DEBOUNCE_MS = 500;
const HEALTHKIT_DATABASE_INACCESSIBLE_CODE = "HEALTHKIT_DATABASE_INACCESSIBLE";

let subscription: EventSubscription | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let observerSyncReady: true | undefined;
let pendingCatchUp:
  | {
      onSyncComplete?: () => void | Promise<void>;
      trpcClient: SyncTrpcClient;
    }
  | undefined;
const pendingUpdateIds = new Set<string>();
let syncing: true | undefined;

type BackgroundHealthKitSyncStage =
  | HealthKitSyncStage
  | {
      operation: "postSyncCallback";
    };

function createStageTelemetry() {
  let active:
    | {
        stage: BackgroundHealthKitSyncStage;
        startedAt: number;
      }
    | undefined;

  function complete(outcome: "succeeded" | "failed"): void {
    if (!active) {
      return;
    }
    logger.info(TAG, "Sync stage completed", {
      ...active.stage,
      durationMs: Math.max(0, Date.now() - active.startedAt),
      outcome,
    });
    active = undefined;
  }

  return {
    start(stage: BackgroundHealthKitSyncStage): void {
      complete("succeeded");
      active = {
        stage,
        startedAt: Date.now(),
      };
      logger.info(TAG, "Sync stage started", { ...stage });
    },
    complete,
  };
}

function isHealthKitDatabaseInaccessible(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === HEALTHKIT_DATABASE_INACCESSIBLE_CODE
  );
}

async function performHealthKitSync(
  trpcClient: SyncTrpcClient,
  onSyncComplete?: () => void | Promise<void>,
): Promise<boolean> {
  const startedAt = Date.now();
  const stageTelemetry = createStageTelemetry();
  logger.info(TAG, "Starting sync");
  let result: Awaited<ReturnType<AppleHealthSyncService["sync"]>>;
  try {
    result = await new AppleHealthSyncService({ trpcClient }).sync({
      syncRangeDays: 1,
      onStage: stageTelemetry.start,
    });
  } catch (error) {
    stageTelemetry.complete("failed");
    const message = error instanceof Error ? error.message : String(error);
    // HealthKit encrypts data at rest while the device is locked. This is a
    // known transient condition (the next foreground event will succeed),
    // not an actionable error, so log it but don't send it to Sentry.
    if (isHealthKitDatabaseInaccessible(error)) {
      logger.info(TAG, "Device locked, skipping sync");
      return false;
    }
    logger.warn(TAG, `Sync failed: ${message}`);
    captureException(error, { source: TAG });
    return false;
  }

  stageTelemetry.complete("succeeded");
  logger.info(TAG, `Sync complete: ${result.inserted} inserted, ${result.errors.length} errors`, {
    durationMs: Math.max(0, Date.now() - startedAt),
    errorCount: result.errors.length,
    inserted: result.inserted,
  });
  try {
    if (onSyncComplete) {
      stageTelemetry.start({ operation: "postSyncCallback" });
      await onSyncComplete();
      stageTelemetry.complete("succeeded");
    }
  } catch (error) {
    stageTelemetry.complete("failed");
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(TAG, `Sync completion callback failed: ${message}`);
    captureException(error, { source: TAG });
  }
  logger.info(TAG, "Observer processing complete", {
    durationMs: Math.max(0, Date.now() - startedAt),
  });
  return true;
}

function acknowledgeObserverUpdates(updateIds: string[], succeeded: boolean): void {
  try {
    completeObserverUpdates(updateIds, succeeded);
  } catch (error) {
    captureException(error, {
      source: TAG,
      operation: "completeObserverUpdates",
      updateCount: updateIds.length,
    });
  }
}

async function drainSyncQueue(
  trpcClient: SyncTrpcClient,
  onSyncComplete?: () => void | Promise<void>,
): Promise<void> {
  if (syncing) {
    return;
  }

  const catchUp = pendingCatchUp;
  if (catchUp) {
    pendingCatchUp = undefined;
  } else if (!observerSyncReady) {
    return;
  }

  const updateIds = catchUp ? [] : Array.from(pendingUpdateIds);
  if (!catchUp) {
    pendingUpdateIds.clear();
    observerSyncReady = undefined;
  }

  syncing = true;
  const succeeded = await performHealthKitSync(
    catchUp?.trpcClient ?? trpcClient,
    catchUp?.onSyncComplete ?? onSyncComplete,
  );
  if (updateIds.length > 0) {
    acknowledgeObserverUpdates(updateIds, succeeded);
  }
  syncing = undefined;

  await drainSyncQueue(trpcClient, onSyncComplete);
}

function scheduleObserverSync(
  trpcClient: SyncTrpcClient,
  onSyncComplete?: () => void | Promise<void>,
): void {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = undefined;
    observerSyncReady = true;
    void drainSyncQueue(trpcClient, onSyncComplete);
  }, DEBOUNCE_MS);
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
  onSyncComplete?: () => void | Promise<void>,
) {
  const authorizationState = await new AppleHealthAuthorizationService().resolve();
  if (!authorizationState.canAttemptSync()) {
    logger.info(TAG, "HealthKit not available, skipping init");
    return;
  }

  // Clean up any existing listener
  if (subscription) {
    logger.info(TAG, "Removing previous listener before re-init");
    teardownBackgroundHealthKitSync();
  }

  // Listen before registering native observers so an immediate HealthKit
  // delivery can never race ahead of the JavaScript callback.
  subscription = addSampleUpdateListener((event) => {
    logger.info(TAG, "Sample update event received, debouncing");
    pendingUpdateIds.add(event.updateId);
    scheduleObserverSync(trpcClient, onSyncComplete);
  });

  try {
    await setupBackgroundObservers();
  } catch (error) {
    captureException(error, {
      source: TAG,
      operation: "setupBackgroundObservers",
    });
    teardownBackgroundHealthKitSync();
    throw error;
  }
  logger.info(TAG, "Background observers registered");
  pendingCatchUp = { trpcClient, onSyncComplete };
  void drainSyncQueue(trpcClient, onSyncComplete);

  logger.info(TAG, "Init complete, listening for HealthKit updates");
}

/** Clean up background sync listeners and timers */
export function teardownBackgroundHealthKitSync() {
  if (subscription) {
    logger.info(TAG, "Tearing down: removing listener");
    subscription.remove();
    subscription = null;
  }
  clearTimeout(debounceTimer);
  debounceTimer = undefined;
  observerSyncReady = undefined;
  pendingCatchUp = undefined;
  pendingUpdateIds.clear();
  try {
    teardownBackgroundObservers();
  } catch (error) {
    captureException(error, {
      source: TAG,
      operation: "teardownBackgroundObservers",
    });
  }
}
