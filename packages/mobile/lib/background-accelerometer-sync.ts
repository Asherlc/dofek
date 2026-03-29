import { AppState, type AppStateStatus, Platform } from "react-native";
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
	syncInertialMeasurementUnitToServer,
	type InertialMeasurementUnitSyncTrpcClient,
} from "./inertial-measurement-unit-sync";

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
	trpcClient: InertialMeasurementUnitSyncTrpcClient,
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

	const deviceId = `iPhone (${Platform.OS} ${Platform.Version})`;

	// Sync whenever the app comes to foreground
	appStateSubscription = AppState.addEventListener(
		"change",
		(nextState: AppStateStatus) => {
			if (nextState !== "active") return;
			if (syncing) return;

			syncing = true;
			syncInertialMeasurementUnitToServer({
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
