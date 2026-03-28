import { AppState, type AppStateStatus } from "react-native";
import { isWatchAppInstalled, isWatchPaired } from "../modules/watch-motion";
import { type AccelerometerSyncTrpcClient, syncAccelerometerToServer } from "./accelerometer-sync";
import { captureException } from "./telemetry";
import { createWatchCoreMotionAdapter } from "./watch-accelerometer-adapter";

const TAG = "bg-watch-accel-sync";

let appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;
let syncing = false;

/**
 * Initialize background Apple Watch accelerometer sync.
 *
 * - Checks if a Watch is paired with the Dofek app installed
 * - Listens for app foreground events and syncs any pending transferred data
 * - Runs an initial sync immediately (AppState listener only fires on transitions)
 * - Should be called once after authentication is established
 */
export async function initBackgroundWatchAccelerometerSync(
  trpcClient: AccelerometerSyncTrpcClient,
): Promise<void> {
  if (!isWatchPaired() || !isWatchAppInstalled()) return;

  // Clean up existing listener
  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
  }

  const adapter = createWatchCoreMotionAdapter();

  // Sync whenever the app comes to foreground
  appStateSubscription = AppState.addEventListener("change", (nextState: AppStateStatus) => {
    if (nextState !== "active") return;
    if (syncing) return;

    syncing = true;
    syncAccelerometerToServer({
      trpcClient,
      coreMotion: adapter,
      deviceId: "Apple Watch",
      deviceType: "apple_watch",
    })
      .catch((error: unknown) => {
        captureException(error, { source: TAG });
      })
      .finally(() => {
        syncing = false;
      });
  });

  // Run an initial sync immediately. The app is already active when init runs,
  // so no AppState "active" event fires until the next background → foreground cycle.
  await syncAccelerometerToServer({
    trpcClient,
    coreMotion: adapter,
    deviceId: "Apple Watch",
    deviceType: "apple_watch",
  });
}

/** Clean up background Watch accelerometer sync listeners. */
export function teardownBackgroundWatchAccelerometerSync(): void {
  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
  }
}
