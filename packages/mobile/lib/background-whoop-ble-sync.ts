import * as Sentry from "@sentry/react-native";
import { Alert, AppState } from "react-native";
import { captureException, logger } from "./telemetry";
import { WhoopBleDiagnostics, type WhoopSyncTrigger } from "./whoop-ble-diagnostics";
import type { WhoopBleSyncDeps, WhoopUploadContext } from "./whoop-ble-sync-types";

const LOG_CATEGORY = "whoop-ble";
interface WhoopBleSyncSession {
  deps: WhoopBleSyncDeps;
  diagnostics: WhoopBleDiagnostics;
  active: boolean;
  connected: boolean;
  connectionIntent: boolean;
  syncing: boolean;
  captureErrorSubscription?: { remove(): void };
  appStateSubscription?: { remove(): void };
  connectionStateSubscription?: { remove(): void };
}
let currentSession: WhoopBleSyncSession | null = null;

function captureSnapshot(
  session: WhoopBleSyncSession,
  trigger: WhoopSyncTrigger,
  appState = AppState.currentState ?? "unknown",
): void {
  if (!session.active) return;
  try {
    session.diagnostics.snapshot(session.deps.getDataPathStats(), trigger, appState);
  } catch (error: unknown) {
    captureException(error, { source: "whoop-ble-capture-diagnostics", trigger });
  }
}
function foreground(): boolean {
  return AppState.currentState === "active";
}

/** Configure native account ownership before any BLE capture can begin. */
export async function initBackgroundWhoopBleSync(
  context: WhoopUploadContext,
  deps: WhoopBleSyncDeps,
): Promise<void> {
  teardownBackgroundWhoopBleSync();
  deps.configureUpload(context);
  const session: WhoopBleSyncSession = {
    deps,
    diagnostics: new WhoopBleDiagnostics(),
    active: true,
    connected: false,
    connectionIntent: false,
    syncing: false,
  };
  currentSession = session;
  try {
    session.captureErrorSubscription = deps.addCaptureErrorListener(({ message }) => {
      if (!session.active) return;
      captureException(new Error(message), { source: "whoop-ble-native-capture" });
      Alert.alert("WHOOP capture stopped", message);
    });
    captureSnapshot(session, "initial");
    session.connectionStateSubscription = deps.addConnectionStateListener((event) => {
      if (!session.active) return;
      if (event.state === "connected") session.connected = true;
      else if (event.state === "disconnected") session.connected = false;
      captureSnapshot(session, "connection");
    });
    session.appStateSubscription = AppState.addEventListener("change", (state) => {
      if (!session.active) return;
      captureSnapshot(session, "app_state", state);
      if (state !== "active") return;
      try {
        deps.flushUploads();
      } catch (error: unknown) {
        captureException(error, { source: "whoop-ble-foreground-flush" });
      }
      if (session.syncing) return;
      session.syncing = true;
      syncOnForeground(session, foreground)
        .catch((error: unknown) => {
          captureException(error, {
            source: "whoop-ble-foreground-sync",
            retiredLifetime: !session.active,
          });
        })
        .finally(() => {
          session.syncing = false;
        });
    });
    deps.flushUploads();
    if (!foreground()) return;
    session.syncing = true;
    try {
      await syncOnForeground(session, foreground);
    } catch (error: unknown) {
      captureException(error, { source: "whoop-ble-init-sync", retiredLifetime: !session.active });
    } finally {
      session.syncing = false;
    }
  } catch (error: unknown) {
    teardownBackgroundWhoopBleSync();
    throw error;
  }
}

/** Ask iOS to deliver the current account's durable queue, independently of BLE connection. */
export async function syncWhoopBle(): Promise<void> {
  const session = currentSession;
  if (!session?.active) return;
  captureSnapshot(session, "background");
  session.deps.flushUploads();
}

async function syncOnForeground(
  session: WhoopBleSyncSession,
  shouldContinueConnecting: () => boolean,
): Promise<void> {
  const { deps: whoopDeps } = session;
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
  if (!session.active || !shouldContinueConnecting()) return;

  if (!session.connected) {
    logger.info(LOG_CATEGORY, "not connected, searching for WHOOP strap");
    const device = await whoopDeps.findWhoop();
    if (!session.active || !shouldContinueConnecting()) return;
    if (!device) {
      logger.warn(LOG_CATEGORY, "no WHOOP strap found");
      Sentry.addBreadcrumb({
        category: "whoop-ble",
        message: "No WHOOP strap found",
        level: "warning",
      });
      return;
    }
    if (!session.active || !shouldContinueConnecting()) return;

    const deviceLabel = device.name ?? device.id;
    logger.info(LOG_CATEGORY, `connecting to ${deviceLabel}`);
    Sentry.addBreadcrumb({
      category: "whoop-ble",
      message: `Connecting to ${deviceLabel}`,
      level: "info",
    });
    session.connectionIntent = true;
    await whoopDeps.connect(device.id);
    if (!session.active) return;
    if (!shouldContinueConnecting()) {
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
      if (session.active) logger.info(LOG_CATEGORY, "TOGGLE_IMU_MODE sent");
    } catch (error: unknown) {
      captureException(error, {
        source: "whoop-ble-start-streaming",
        ...(session.active ? {} : { retiredLifetime: true }),
      });
      if (!session.active) return;
      // Best-effort — passive data may still flow without the command
      logger.warn(LOG_CATEGORY, `startImuStreaming failed (passive data may still work): ${error}`);
    }
    if (!session.active) return;
    if (!shouldContinueConnecting()) {
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
    logger.info(LOG_CATEGORY, "already connected");
  }
}

/** Retire JavaScript connection work while preserving native account ownership and queued uploads. */
export function teardownBackgroundWhoopBleSync(): void {
  const session = currentSession;
  if (!session) return;
  currentSession = null;
  captureSnapshot(session, "teardown");
  session.active = false;
  session.captureErrorSubscription?.remove();
  session.appStateSubscription?.remove();
  session.connectionStateSubscription?.remove();
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
