import {
  acknowledgeWatchSamples,
  getLastWatchSyncTimestamp,
  getPendingWatchSamples,
  isWatchAppInstalled,
  isWatchPaired,
  requestWatchRecording,
  setLastWatchSyncTimestamp,
} from "../modules/watch-motion";
import type { InertialMeasurementUnitAdapter } from "./inertial-measurement-unit-sync";

/**
 * Creates an InertialMeasurementUnitAdapter that reads IMU data from a paired
 * Apple Watch via WCSession file transfers, rather than from the local
 * iPhone's CMSensorRecorder.
 *
 * This adapter plugs into the existing `syncInertialMeasurementUnitToServer()` pipeline
 * unchanged — the only difference is where the samples come from.
 */
export function createWatchInertialMeasurementUnitAdapter(): InertialMeasurementUnitAdapter {
  const paired = isWatchPaired();
  const installed = isWatchAppInstalled();

  return {
    isAccelerometerRecordingAvailable(): boolean {
      return paired && installed;
    },

    async queryRecordedData(_fromDate: string, _toDate: string) {
      // Watch transfers entire files — we return all pending samples.
      // Date filtering is not needed because the Watch only sends
      // samples newer than the last acknowledged sync.
      return getPendingWatchSamples();
    },

    getLastSyncTimestamp(): string | null {
      return getLastWatchSyncTimestamp();
    },

    setLastSyncTimestamp(timestamp: string): void {
      setLastWatchSyncTimestamp(timestamp);
      // After advancing the cursor, delete the processed transfer files
      acknowledgeWatchSamples();
    },

    async startRecording(_durationSeconds: number): Promise<boolean> {
      // Ask the Watch to restart recording AND transfer data.
      // This keeps the 12-hour CMSensorRecorder sessions rolling
      // even if the user never opens the Watch app.
      await requestWatchRecording();
      return true;
    },

    isRecordingActive(): boolean {
      // The Watch app records continuously when installed.
      // We report active if the Watch is paired + app installed.
      return paired && installed;
    },
  };
}
