import CoreMotionModule from "./src/CoreMotionModule";

export interface AccelerometerSample {
  timestamp: string; // ISO 8601 with milliseconds
  x: number; // acceleration in g
  y: number; // acceleration in g
  z: number; // acceleration in g
}

export type MotionAuthorizationStatus = "authorized" | "denied" | "restricted" | "notDetermined";

/** Check whether CMSensorRecorder is available on this device.
 * Requires a device with a motion coprocessor (iPhone 5s+). */
export function isAccelerometerRecordingAvailable(): boolean {
  return CoreMotionModule.isAccelerometerRecordingAvailable();
}

/** Get the current Core Motion authorization status. */
export function getMotionAuthorizationStatus(): MotionAuthorizationStatus {
  return CoreMotionModule.getMotionAuthorizationStatus();
}

/** Request permission to access motion data.
 * Triggers the system permission dialog if not yet determined.
 * Returns the resulting authorization status. */
export async function requestMotionPermission(): Promise<MotionAuthorizationStatus> {
  return CoreMotionModule.requestMotionPermission();
}

/** Start recording accelerometer data in the background.
 * Recording continues even when the app is suspended or killed.
 * Maximum duration is 12 hours (43,200 seconds).
 * @param durationSeconds — how long to record (clamped to 12 hours) */
export async function startRecording(durationSeconds: number): Promise<boolean> {
  return CoreMotionModule.startRecording(durationSeconds);
}

/** Check whether a recording session was previously started. */
export function isRecordingActive(): boolean {
  return CoreMotionModule.isRecordingActive();
}

/** Query recorded accelerometer data between two dates.
 * CMSensorRecorder retains up to 3 days of history.
 * Data is returned at 50 Hz (50 samples per second).
 * @param fromDate — ISO 8601 start date
 * @param toDate — ISO 8601 end date
 * @returns Array of {timestamp, x, y, z} samples */
export async function queryRecordedData(
  fromDate: string,
  toDate: string,
): Promise<AccelerometerSample[]> {
  return CoreMotionModule.queryRecordedData(fromDate, toDate);
}

/** Get the timestamp of the last successful accelerometer sync.
 * Returns null if never synced. */
export function getLastSyncTimestamp(): string | null {
  return CoreMotionModule.getLastSyncTimestamp();
}

/** Update the last sync timestamp after a successful upload. */
export function setLastSyncTimestamp(timestamp: string): void {
  CoreMotionModule.setLastSyncTimestamp(timestamp);
}
