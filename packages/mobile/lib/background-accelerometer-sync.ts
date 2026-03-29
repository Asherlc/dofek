import { AppState, type AppStateStatus, Platform } from "react-native";
import {
  getLastSyncTimestamp,
  getMotionAuthorizationStatus,
  isAccelerometerRecordingAvailable,
  isRecordingActive,
  queryRecordedData,
  requestMotionPermission,
  setLastSyncTimestamp,
  startRecording,
} from "../modules/core-motion";
import {
  type InertialMeasurementUnitSyncTrpcClient,
  syncInertialMeasurementUnitToServer,
} from "./inertial-measurement-unit-sync";
import { captureException } from "./telemetry";

const TAG = "bg-accel-sync";
const TWELVE_HOURS_SECONDS = 12 * 3600;

let appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;
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

  let status = getMotionAuthorizationStatus();
  if (status === "notDetermined") {
    status = await requestMotionPermission();
  }
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
  appStateSubscription = AppState.addEventListener("change", (nextState: AppStateStatus) => {
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
      .catch((error: unknown) => {
        captureException(error, { source: TAG });
      })
      .finally(() => {
        syncing = false;
      });
  });
}

/** Clean up background accelerometer sync listeners */
export function teardownBackgroundAccelerometerSync(): void {
  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
  }
}
