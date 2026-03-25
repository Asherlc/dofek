import { AppState, type AppStateStatus } from "react-native";
import * as Device from "expo-device";
import {
	getMotionAuthorizationStatus,
	isAccelerometerRecordingAvailable,
	queryRecordedData,
	getLastSyncTimestamp,
	setLastSyncTimestamp,
	startRecording,
	isRecordingActive,
} from "../modules/core-motion";
import {
	syncAccelerometerToServer,
	type AccelerometerSyncTrpcClient,
} from "./accelerometer-sync";

const TWELVE_HOURS_SECONDS = 12 * 3600;

let appStateSubscription: ReturnType<typeof AppState.addEventListener> | null =
	null;
let syncing = false;

/**
 * Initialize background accelerometer sync.
 *
 * - Starts a 12-hour recording session immediately
 * - Listens for app foreground events and syncs recorded data
 * - Should be called once after authentication is established
 */
export async function initBackgroundAccelerometerSync(
	trpcClient: AccelerometerSyncTrpcClient,
): Promise<void> {
	if (!isAccelerometerRecordingAvailable()) return;

	const status = getMotionAuthorizationStatus();
	if (status !== "authorized") return;

	// Start recording immediately
	await startRecording(TWELVE_HOURS_SECONDS);

	// Clean up existing listener
	if (appStateSubscription) {
		appStateSubscription.remove();
		appStateSubscription = null;
	}

	const deviceId = `${Device.modelName ?? "iPhone"} (${Device.modelId ?? "unknown"})`;

	// Sync whenever the app comes to foreground
	appStateSubscription = AppState.addEventListener(
		"change",
		(nextState: AppStateStatus) => {
			if (nextState !== "active") return;
			if (syncing) return;

			syncing = true;
			syncAccelerometerToServer({
				trpcClient,
				coreMotion: {
					isAccelerometerRecordingAvailable,
					queryRecordedData,
					getLastSyncTimestamp,
					setLastSyncTimestamp,
					startRecording,
					isRecordingActive,
				},
				deviceId,
				deviceType: "iphone",
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

/** Clean up background accelerometer sync listeners */
export function teardownBackgroundAccelerometerSync(): void {
	if (appStateSubscription) {
		appStateSubscription.remove();
		appStateSubscription = null;
	}
}
