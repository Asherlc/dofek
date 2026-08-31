import type { EventSubscription } from "expo-modules-core";
import {
  addSampleUpdateListener,
  completeObserverUpdates,
  setObserverSyncInProgress,
  setupBackgroundObservers,
  teardownBackgroundObservers,
} from "./platform-native/health";
import { AppleHealthAuthorizationService, AppleHealthSyncService } from "./apple-health-provider";
import {
  isBackgroundHealthKitTransientNetworkError,
  isHealthKitDatabaseInaccessible,
  isTransientNetworkErrorMessage,
} from "./health-kit-errors";
import {
  BACKGROUND_HEALTH_KIT_TYPES,
  type HealthKitSyncStage,
  type SyncTrpcClient,
} from "./health-kit-sync";
import { captureException, logger } from "./telemetry";

const TAG = "bg-healthkit-sync";

interface SyncContext {
  onSyncComplete?: () => void | Promise<void>;
  trpcClient: SyncTrpcClient;
}

let subscription: EventSubscription | null = null;
let currentSyncContext: SyncContext | undefined;
let pendingCatchUp: SyncContext | undefined;
const pendingUpdates = new Map<string, string>();
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

  function complete(outcome: "completed" | "failed"): void {
    if (!active) {
      return;
    }
    logger.info(TAG, "Sync stage completed", {
      ...active.stage,
      durationMs: performance.now() - active.startedAt,
      outcome,
    });
    active = undefined;
  }

  return {
    start(stage: BackgroundHealthKitSyncStage): void {
      complete("completed");
      active = {
        stage,
        startedAt: performance.now(),
      };
      logger.info(TAG, "Sync stage started", { ...stage });
    },
    complete,
  };
}
async function performHealthKitSync(
  trpcClient: SyncTrpcClient,
  typeIdentifiers: readonly string[],
  onSyncComplete?: () => void | Promise<void>,
): Promise<boolean> {
  const startedAt = performance.now();
  const stageTelemetry = createStageTelemetry();
  logger.info(TAG, "Starting sync");
  let result: Awaited<ReturnType<AppleHealthSyncService["syncObserverChanges"]>>;
  try {
    result = await new AppleHealthSyncService({ trpcClient }).syncObserverChanges({
      typeIdentifiers,
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
    if (isBackgroundHealthKitTransientNetworkError(error)) {
      logger.info(TAG, "Background HealthKit upload timed out; retrying on next delivery");
      return false;
    }
    logger.warn(TAG, `Sync failed: ${message}`);
    captureException(error, { source: TAG });
    return false;
  }

  if (result.errors.length > 0) {
    const actionableErrors = result.errors.filter(
      (message) => !isTransientNetworkErrorMessage(message),
    );
    if (actionableErrors.length === 0) {
      stageTelemetry.complete("failed");
      logger.info(TAG, "Background HealthKit upload timed out; retrying on next delivery");
      return false;
    }
    stageTelemetry.complete("failed");
    const error = new Error(
      `HealthKit observer sync completed with ${actionableErrors.length} error(s): ${actionableErrors.join("; ")}`,
    );
    logger.warn(TAG, error.message);
    captureException(error, {
      errorCount: actionableErrors.length,
      source: TAG,
    });
    return false;
  }

  stageTelemetry.complete("completed");
  logger.info(
    TAG,
    `Sync complete: ${result.inserted} inserted, ${result.deleted} deleted, ${result.errors.length} errors`,
    {
      deleted: result.deleted,
      durationMs: performance.now() - startedAt,
      errorCount: result.errors.length,
      inserted: result.inserted,
    },
  );
  try {
    if (onSyncComplete) {
      stageTelemetry.start({ operation: "postSyncCallback" });
      await onSyncComplete();
      stageTelemetry.complete("completed");
    }
  } catch (error) {
    stageTelemetry.complete("failed");
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(TAG, `Sync completion callback failed: ${message}`);
    captureException(error, { source: TAG });
  }
  logger.info(TAG, "Observer processing complete", {
    durationMs: performance.now() - startedAt,
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

async function drainSyncQueue(): Promise<void> {
  const context = currentSyncContext;
  if (syncing || !context) {
    return;
  }

  const catchUp = pendingCatchUp === context;
  if (catchUp) {
    pendingCatchUp = undefined;
  } else if (pendingUpdates.size === 0) {
    return;
  }

  const updateIds = catchUp ? [] : Array.from(pendingUpdates.keys());
  const typeIdentifiers = catchUp
    ? BACKGROUND_HEALTH_KIT_TYPES
    : [...new Set(pendingUpdates.values())];
  if (!catchUp) {
    pendingUpdates.clear();
  }

  syncing = true;
  setObserverSyncInProgress(true);
  try {
    const succeeded = await performHealthKitSync(
      context.trpcClient,
      typeIdentifiers,
      context.onSyncComplete
        ? async () => {
            if (currentSyncContext === context) {
              await context.onSyncComplete?.();
            }
          }
        : undefined,
    );
    if (currentSyncContext === context && updateIds.length > 0) {
      acknowledgeObserverUpdates(updateIds, succeeded);
    }
  } catch (error) {
    captureException(error, {
      source: TAG,
      operation: "drainSyncQueue",
    });
    if (currentSyncContext === context && updateIds.length > 0) {
      acknowledgeObserverUpdates(updateIds, false);
    }
  } finally {
    syncing = undefined;
    setObserverSyncInProgress(pendingCatchUp !== undefined || pendingUpdates.size > 0);
  }

  await drainSyncQueue();
}

/**
 * Initialize background HealthKit sync.
 * Sets up observer queries that fire when new health samples arrive,
 * then serializes syncs of the last 24 hours of data to the server.
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

  const context: SyncContext = { trpcClient, onSyncComplete };
  currentSyncContext = context;

  // Listen before registering native observers so an immediate HealthKit
  // delivery can never race ahead of the JavaScript callback.
  subscription = addSampleUpdateListener((event) => {
    if (currentSyncContext !== context) {
      return;
    }
    logger.info(TAG, "Sample update event received, queueing type-scoped sync", {
      typeIdentifier: event.typeIdentifier,
    });
    pendingUpdates.set(event.updateId, event.typeIdentifier);
    setObserverSyncInProgress(true);
    void drainSyncQueue();
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
  pendingCatchUp = context;
  void drainSyncQueue();

  logger.info(TAG, "Init complete, listening for HealthKit updates");
}

/** Clean up background sync listeners and observers. */
export function teardownBackgroundHealthKitSync() {
  currentSyncContext = undefined;
  if (subscription) {
    logger.info(TAG, "Tearing down: removing listener");
    subscription.remove();
    subscription = null;
  }
  pendingCatchUp = undefined;
  pendingUpdates.clear();
  try {
    teardownBackgroundObservers();
  } catch (error) {
    captureException(error, {
      source: TAG,
      operation: "teardownBackgroundObservers",
    });
  }
}
