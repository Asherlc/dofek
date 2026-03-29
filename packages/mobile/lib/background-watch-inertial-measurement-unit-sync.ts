import { AppState, type AppStateStatus } from "react-native";
import { isWatchPaired, isWatchAppInstalled } from "../modules/watch-motion";
import { createWatchInertialMeasurementUnitAdapter } from "./watch-inertial-measurement-unit-adapter";
import {
	syncInertialMeasurementUnitToServer,
	type InertialMeasurementUnitSyncTrpcClient,
} from "./inertial-measurement-unit-sync";

let appStateSubscription: ReturnType<typeof AppState.addEventListener> | null =
	null;
let syncing = false;

/**
 * Initialize background Apple Watch IMU sync.
 *
 * - Checks if a Watch is paired with the Dofek app installed
 * - Listens for app foreground events and syncs any pending transferred data
 * - Should be called once after authentication is established
 */
export async function initBackgroundWatchInertialMeasurementUnitSync(
	trpcClient: InertialMeasurementUnitSyncTrpcClient,
): Promise<void> {
	if (!isWatchPaired() || !isWatchAppInstalled()) return;

	// Clean up existing listener
	if (appStateSubscription) {
		appStateSubscription.remove();
		appStateSubscription = null;
	}

	const adapter = createWatchInertialMeasurementUnitAdapter();

	// Sync whenever the app comes to foreground
	appStateSubscription = AppState.addEventListener(
		"change",
		(nextState: AppStateStatus) => {
			if (nextState !== "active") return;
			if (syncing) return;

			syncing = true;
			syncInertialMeasurementUnitToServer({
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

/** Clean up background Watch IMU sync listeners. */
export function teardownBackgroundWatchInertialMeasurementUnitSync(): void {
	if (appStateSubscription) {
		appStateSubscription.remove();
		appStateSubscription = null;
	}
}
