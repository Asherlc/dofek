import * as Sentry from "@sentry/react-native";
import { AppState, type AppStateStatus } from "react-native";
import type { AccelerometerUploadClient } from "./accelerometer-service";
import { captureException } from "./telemetry";

const UPLOAD_BATCH_SIZE = 5000;

/** Dependencies injected for testability (wraps the whoop-ble native module) */
export interface WhoopBleSyncDeps {
  isBluetoothAvailable(): boolean;
  findWhoop(): Promise<{ id: string; name: string | null } | null>;
  connect(peripheralId: string): Promise<boolean>;
  startImuStreaming(): Promise<boolean>;
  stopImuStreaming(): Promise<boolean>;
  getBufferedSamples(): Promise<
    Array<{
      timestamp: string;
      accelerometerX: number;
      accelerometerY: number;
      accelerometerZ: number;
      gyroscopeX: number;
      gyroscopeY: number;
      gyroscopeZ: number;
    }>
  >;
  disconnect(): void;
}

let appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;
let syncing = false;
let connected = false;
let currentDeps: WhoopBleSyncDeps | null = null;

/**
 * Initialize always-on WHOOP BLE accelerometer sync.
 *
 * - Connects to the WHOOP strap and starts IMU streaming immediately
 * - On subsequent foreground events, uploads buffered samples (streaming stays on)
 * - Should be called once after authentication when the setting is enabled
 */
export async function initBackgroundWhoopBleSync(
  trpcClient: AccelerometerUploadClient,
  whoopDeps: WhoopBleSyncDeps,
): Promise<void> {
  currentDeps = whoopDeps;

  // Clean up existing listener
  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
  }

  // Sync whenever the app comes to foreground
  appStateSubscription = AppState.addEventListener("change", (nextState: AppStateStatus) => {
    if (nextState !== "active") return;
    if (syncing) return;

    syncing = true;
    syncOnForeground(trpcClient, whoopDeps)
      .catch((error: unknown) => {
        Sentry.captureException(error, { tags: { source: "whoop-ble-foreground-sync" } });
      })
      .finally(() => {
        syncing = false;
      });
  });

  // Do an initial sync immediately — the AppState listener only fires on
  // state *transitions*, so if the app is already active when init is called
  // (the common case), nothing would happen until the user backgrounds and
  // re-opens the app. Best-effort: don't let init failures propagate.
  try {
    await syncOnForeground(trpcClient, whoopDeps);
  } catch (error: unknown) {
    Sentry.captureException(error, { tags: { source: "whoop-ble-init-sync" } });
  }
}

async function syncOnForeground(
  trpcClient: AccelerometerUploadClient,
  whoopDeps: WhoopBleSyncDeps,
): Promise<void> {
  if (!whoopDeps.isBluetoothAvailable()) {
    Sentry.addBreadcrumb({
      category: "whoop-ble",
      message: "Bluetooth not available, skipping sync",
      level: "warning",
    });
    return;
  }

  // Connect if not already connected
  if (!connected) {
    const device = await whoopDeps.findWhoop();
    if (!device) {
      Sentry.addBreadcrumb({
        category: "whoop-ble",
        message: "No WHOOP strap found",
        level: "warning",
      });
      return;
    }

    Sentry.addBreadcrumb({
      category: "whoop-ble",
      message: `Connecting to ${device.name ?? device.id}`,
      level: "info",
    });
    await whoopDeps.connect(device.id);
    await whoopDeps.startImuStreaming();
    connected = true;
    Sentry.addBreadcrumb({
      category: "whoop-ble",
      message: "Connected and streaming",
      level: "info",
    });
  }

  // Upload any buffered samples
  const samples = await whoopDeps.getBufferedSamples();
  if (samples.length > 0) {
    // Convert to the accelerometer sample format (x/y/z) for the upload endpoint
    const uploadSamples = samples.map((sample) => ({
      timestamp: sample.timestamp,
      x: sample.accelerometerX,
      y: sample.accelerometerY,
      z: sample.accelerometerZ,
    }));

    for (let offset = 0; offset < uploadSamples.length; offset += UPLOAD_BATCH_SIZE) {
      const batch = uploadSamples.slice(offset, offset + UPLOAD_BATCH_SIZE);
      await trpcClient.accelerometerSync.pushAccelerometerSamples.mutate({
        deviceId: "WHOOP Strap",
        deviceType: "whoop",
        samples: batch,
      });
    }
  }
}

/** Clean up background WHOOP BLE sync listeners and disconnect */
export function teardownBackgroundWhoopBleSync(): void {
  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
  }

  if (connected && currentDeps) {
    try {
      currentDeps.stopImuStreaming().catch((error: unknown) => {
        captureException(error, { source: "whoop-ble-teardown" });
      });
    } catch {
      // Best-effort cleanup
    }
    currentDeps.disconnect();
    connected = false;
  }

  currentDeps = null;
  syncing = false;
}
