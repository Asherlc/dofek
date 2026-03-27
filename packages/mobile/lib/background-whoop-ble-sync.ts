import { AppState, type AppStateStatus } from "react-native";
import type { AccelerometerUploadClient } from "./accelerometer-service";

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
 * - Connects to the WHOOP strap and starts IMU streaming on first foreground
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
      .catch(() => {
        // Best-effort — don't crash the app
      })
      .finally(() => {
        syncing = false;
      });
  });
}

async function syncOnForeground(
  trpcClient: AccelerometerUploadClient,
  whoopDeps: WhoopBleSyncDeps,
): Promise<void> {
  if (!whoopDeps.isBluetoothAvailable()) return;

  // Connect if not already connected
  if (!connected) {
    const device = await whoopDeps.findWhoop();
    if (!device) return;

    await whoopDeps.connect(device.id);
    await whoopDeps.startImuStreaming();
    connected = true;
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
      currentDeps.stopImuStreaming().catch(() => {});
    } catch {
      // Best-effort cleanup
    }
    currentDeps.disconnect();
    connected = false;
  }

  currentDeps = null;
  syncing = false;
}
