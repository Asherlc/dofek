import { AppState, type AppStateStatus } from "react-native";
import { isWatchPaired, isWatchAppInstalled } from "../modules/watch-motion";
import { createWatchCoreMotionAdapter } from "./watch-accelerometer-adapter";
import {
	syncAccelerometerToServer,
	type AccelerometerSyncTrpcClient,
} from "./accelerometer-sync";

let appStateSubscription: ReturnType<typeof AppState.addEventListener> | null =
	null;
let syncing = false;

/**
 * Initialize background Apple Watch accelerometer sync.
 *
 * - Checks if a Watch is paired with the Dofek app installed
 * - Listens for app foreground events and syncs any pending transferred data
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
	appStateSubscription = AppState.addEventListener(
		"change",
		(nextState: AppStateStatus) => {
			if (nextState !== "active") return;
			if (syncing) return;

			syncing = true;
			syncAccelerometerToServer({
				trpcClient,
				coreMotion: adapter,
				deviceId: "Apple Watch",
				deviceType: "apple_watch",
			})
				.catch(() => {
					// Best-effort — don't crash the app for background sync failures
				})
				.finally(() => {
					syncing = false;
				});
		},
	);
}

/** Clean up background Watch accelerometer sync listeners. */
export function teardownBackgroundWatchAccelerometerSync(): void {
	if (appStateSubscription) {
		appStateSubscription.remove();
		appStateSubscription = null;
	}
}
