import * as Sentry from "@sentry/react-native";
import { AppState, type AppStateStatus } from "react-native";
import { captureException, logger } from "./telemetry";
import { WhoopBleDiagnostics, type WhoopSyncTrigger } from "./whoop-ble-diagnostics";
import type {
  InertialMeasurementUnitUploadClient,
  WhoopBleRealtimeUploadClient,
  WhoopBleSyncDeps,
} from "./whoop-ble-sync-types";
import { WhoopBleUploadWorkers } from "./whoop-ble-upload-workers";

const PERIODIC_DRAIN_INTERVAL_MS = 30_000;
const LOG_CATEGORY = "whoop-ble";

interface WhoopBleSyncSession {
  deps: WhoopBleSyncDeps;
  realtimeClient: WhoopBleRealtimeUploadClient | undefined;
  workers: WhoopBleUploadWorkers;
  diagnostics: WhoopBleDiagnostics;
  connected: boolean;
  connectionIntent: boolean;
  syncing: boolean;
  appStateSubscription?: { remove(): void };
  connectionStateSubscription?: { remove(): void };
  periodicDrainTimer?: ReturnType<typeof setInterval>;
}

let currentSession: WhoopBleSyncSession | null = null;

function createSession(
  client: InertialMeasurementUnitUploadClient,
  deps: WhoopBleSyncDeps,
  realtimeClient?: WhoopBleRealtimeUploadClient,
): WhoopBleSyncSession {
  const diagnostics = new WhoopBleDiagnostics();
  const session: WhoopBleSyncSession = {
    deps,
    realtimeClient,
    diagnostics,
    workers: new WhoopBleUploadWorkers(client, deps, diagnostics),
    connected: false,
    connectionIntent: false,
    syncing: false,
  };
  currentSession = session;
  return session;
}

function captureSnapshot(
  session: WhoopBleSyncSession,
  trigger: WhoopSyncTrigger,
  appState = AppState.currentState ?? "unknown",
): void {
  if (!session.workers.active) return;
  try {
    session.diagnostics.snapshot(session.deps.getDataPathStats(), trigger, appState);
  } catch (error: unknown) {
    captureException(error, { source: "whoop-ble-capture-diagnostics", trigger });
  }
}

function shouldRunForegroundPeriodicDrain(): boolean {
  return AppState.currentState === "active";
}

function stopPeriodicDrainTimer(session: WhoopBleSyncSession): void {
  if (session.periodicDrainTimer === undefined) return;
  clearInterval(session.periodicDrainTimer);
  session.periodicDrainTimer = undefined;
}

function startPeriodicDrainTimer(session: WhoopBleSyncSession): void {
  if (
    !session.workers.active ||
    !shouldRunForegroundPeriodicDrain() ||
    session.periodicDrainTimer !== undefined
  )
    return;
  session.periodicDrainTimer = setInterval(() => {
    if (!session.workers.active || !shouldRunForegroundPeriodicDrain()) {
      stopPeriodicDrainTimer(session);
      return;
    }
    captureSnapshot(session, "periodic");
    if (!session.connected) {
      session.diagnostics.skipped("imu", "not_connected", "periodic");
      session.diagnostics.skipped("realtime", "not_connected", "periodic");
      return;
    }
    session.workers
      .drain(session.realtimeClient, shouldRunForegroundPeriodicDrain, "periodic")
      .catch((error: unknown) => {
        captureException(error, {
          source: "whoop-ble-periodic-drain",
          ...(session.workers.active ? {} : { retiredLifetime: true }),
        });
        if (session.workers.active) logger.error(LOG_CATEGORY, `periodic drain error: ${error}`);
      });
  }, PERIODIC_DRAIN_INTERVAL_MS);
}

/** Start the WHOOP connection and upload lifecycle for the current client. */
export async function initBackgroundWhoopBleSync(
  client: InertialMeasurementUnitUploadClient,
  deps: WhoopBleSyncDeps,
  realtimeClient?: WhoopBleRealtimeUploadClient,
): Promise<void> {
  teardownBackgroundWhoopBleSync();
  const session = createSession(client, deps, realtimeClient);
  captureSnapshot(session, "initial");
  session.connectionStateSubscription = deps.addConnectionStateListener((event) => {
    if (!session.workers.active) return;
    captureSnapshot(session, "connection");
    if (event.state === "disconnected") {
      logger.info(LOG_CATEGORY, `BLE disconnected (${event.error ?? "no error"}), will reconnect`);
      session.connected = false;
    } else if (event.state === "connected") {
      logger.info(LOG_CATEGORY, "BLE reconnected");
      session.connected = true;
    }
  });
  session.appStateSubscription = AppState.addEventListener(
    "change",
    (nextState: AppStateStatus) => {
      if (!session.workers.active) return;
      captureSnapshot(session, "app_state", nextState);
      if (nextState !== "active") {
        stopPeriodicDrainTimer(session);
        return;
      }
      startPeriodicDrainTimer(session);
      if (session.syncing) {
        session.diagnostics.skipped("imu", "already_syncing", "foreground");
        session.diagnostics.skipped("realtime", "already_syncing", "foreground");
        return;
      }
      session.syncing = true;
      syncOnForeground(session, shouldRunForegroundPeriodicDrain, "foreground")
        .catch((error: unknown) => {
          captureException(error, {
            source: "whoop-ble-foreground-sync",
            ...(session.workers.active ? {} : { retiredLifetime: true }),
          });
          if (session.workers.active) logger.error(LOG_CATEGORY, `foreground sync error: ${error}`);
        })
        .finally(() => {
          session.syncing = false;
        });
    },
  );
  startPeriodicDrainTimer(session);
  if (!shouldRunForegroundPeriodicDrain()) {
    logger.info(LOG_CATEGORY, "initial sync deferred until app foregrounds");
    return;
  }
  session.syncing = true;
  try {
    await syncOnForeground(session, shouldRunForegroundPeriodicDrain, "initial");
    if (session.workers.active) logger.info(LOG_CATEGORY, "initial sync complete");
  } catch (error: unknown) {
    captureException(error, {
      source: "whoop-ble-init-sync",
      ...(session.workers.active ? {} : { retiredLifetime: true }),
    });
    if (session.workers.active) logger.error(LOG_CATEGORY, `initial sync error: ${error}`);
  } finally {
    session.syncing = false;
  }
}

/** Flush during an authorized native background refresh, sharing only this lifetime's workers. */
export async function syncWhoopBle(
  client: InertialMeasurementUnitUploadClient,
  deps: WhoopBleSyncDeps,
  realtimeClient?: WhoopBleRealtimeUploadClient,
): Promise<void> {
  const session = currentSession ?? createSession(client, deps, realtimeClient);
  if (realtimeClient) session.realtimeClient = realtimeClient;
  const finishBackgroundRefresh = session.workers.authorizeBackgroundRefresh();
  try {
    captureSnapshot(session, "background");
    await syncOnForeground(session, () => true, "background");
    if (session.workers.active) logger.info(LOG_CATEGORY, "background refresh — sync complete");
  } catch (error: unknown) {
    if (session.workers.active && isWhoopBleConnectionTimeout(error)) {
      logger.warn(
        LOG_CATEGORY,
        "background refresh — connect timed out, uploading buffered samples without a strap",
      );
      Sentry.addBreadcrumb({
        category: "whoop-ble",
        message: "Background refresh connect timed out",
        level: "warning",
      });
      await session.workers.drain(session.realtimeClient, () => true, "background");
      return;
    }
    captureException(error, {
      source: "whoop-ble-background-refresh",
      ...(session.workers.active ? {} : { retiredLifetime: true }),
    });
    if (session.workers.active)
      logger.error(LOG_CATEGORY, `background refresh sync error: ${error}`);
    throw error;
  } finally {
    finishBackgroundRefresh();
  }
}

function isWhoopBleConnectionTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "TIMEOUT";
}

async function syncOnForeground(
  session: WhoopBleSyncSession,
  shouldContinueUploading: () => boolean,
  trigger: WhoopSyncTrigger,
): Promise<void> {
  const { deps: whoopDeps, workers } = session;
  // Connect if not already connected.
  //
  // Note: we skip the isBluetoothAvailable() pre-check because it suffers
  // from a race condition on the very first call. The CBCentralManager is
  // created lazily by ensureCentralManager(), but state starts as .unknown
  // and transitions to .poweredOn asynchronously via a delegate callback.
  // So the first isBluetoothAvailable() call always returns false, aborting
  // the sync before findWhoop() can even run. Instead, we let findWhoop()
  // handle unavailable Bluetooth by returning null (it checks state internally
  // after the manager has had time to initialize).
  if (!workers.active || !shouldContinueUploading()) return;

  if (!session.connected) {
    logger.info(LOG_CATEGORY, "not connected, searching for WHOOP strap");
    const device = await whoopDeps.findWhoop();
    if (!workers.active) return;
    if (!device) {
      logger.warn(LOG_CATEGORY, "no WHOOP strap found");
      Sentry.addBreadcrumb({
        category: "whoop-ble",
        message: "No WHOOP strap found",
        level: "warning",
      });
      return;
    }
    if (!workers.active || !shouldContinueUploading()) return;

    const deviceLabel = device.name ?? device.id;
    logger.info(LOG_CATEGORY, `connecting to ${deviceLabel}`);
    Sentry.addBreadcrumb({
      category: "whoop-ble",
      message: `Connecting to ${deviceLabel}`,
      level: "info",
    });
    session.connectionIntent = true;
    await whoopDeps.connect(device.id);
    if (!workers.active) return;
    if (!shouldContinueUploading()) {
      whoopDeps.disconnect();
      session.connected = false;
      return;
    }
    logger.info(LOG_CATEGORY, "connected, sending TOGGLE_IMU_MODE");
    // Send TOGGLE_IMU_MODE to keep IMU data flowing even when the WHOOP
    // app isn't actively syncing. R21 data also flows passively during
    // WHOOP app sync, but this ensures continuous capture regardless.
    try {
      await whoopDeps.startImuStreaming();
      if (workers.active) logger.info(LOG_CATEGORY, "TOGGLE_IMU_MODE sent");
    } catch (error: unknown) {
      captureException(error, {
        source: "whoop-ble-start-streaming",
        ...(workers.active ? {} : { retiredLifetime: true }),
      });
      if (!workers.active) return;
      // Best-effort — passive data may still flow without the command
      logger.warn(LOG_CATEGORY, `startImuStreaming failed (passive data may still work): ${error}`);
    }
    if (!workers.active) return;
    if (!shouldContinueUploading()) {
      whoopDeps.disconnect();
      session.connected = false;
      return;
    }
    session.connected = true;
    logger.info(LOG_CATEGORY, "listening for IMU data");
    Sentry.addBreadcrumb({
      category: "whoop-ble",
      message: "Connected and streaming",
      level: "info",
    });
  } else {
    logger.info(LOG_CATEGORY, "already connected, uploading buffer");
  }

  await workers.drain(session.realtimeClient, shouldContinueUploading, trigger);
}

/** Retire upload ownership immediately; native cursor handoff waits only for pending peeks. */
export function teardownBackgroundWhoopBleSync(): void {
  const session = currentSession;
  if (!session) return;
  currentSession = null;
  captureSnapshot(session, "teardown");
  session.workers.retire();
  session.appStateSubscription?.remove();
  session.connectionStateSubscription?.remove();
  stopPeriodicDrainTimer(session);
  if (session.connected) {
    try {
      session.deps.stopImuStreaming().catch((error: unknown) => {
        captureException(error, { source: "whoop-ble-teardown", retiredLifetime: true });
      });
    } catch (error: unknown) {
      captureException(error, { source: "whoop-ble-teardown-sync", retiredLifetime: true });
    }
  }
  if (session.connected || session.connectionIntent) session.deps.disconnect();
}
