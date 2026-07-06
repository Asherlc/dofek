import type { InertialMeasurementUnitSample } from "@dofek/imu";
import WatchMotionModule from "./src/WatchMotionModule";

export interface WatchSyncStatus {
  isSupported: boolean;
  isPaired: boolean;
  isReachable: boolean;
  isWatchAppInstalled: boolean;
  pendingFileCount: number;
}

/** Check if WCSession is supported on this device (always true on iPhone). */
export function isWatchSupported(): boolean {
  return WatchMotionModule.isWatchSupported();
}

/** Check if an Apple Watch is paired with this iPhone. */
export function isWatchPaired(): boolean {
  return WatchMotionModule.isWatchPaired();
}

/** Check if the Dofek Watch app is installed on the paired Watch. */
export function isWatchAppInstalled(): boolean {
  return WatchMotionModule.isWatchAppInstalled();
}

/** Get comprehensive Watch connectivity status. */
export function getWatchSyncStatus(): WatchSyncStatus {
  return WatchMotionModule.getWatchSyncStatus();
}

/** Send a message to the Watch requesting it transfer recorded accelerometer data.
 * Returns true if the message was sent, false if Watch is not reachable. */
export async function requestWatchSync(): Promise<boolean> {
  return WatchMotionModule.requestWatchSync();
}

/** Ask the Watch to restart its accelerometer recording session.
 * This ensures continuous coverage even if the user never opens the Watch app —
 * the iPhone can keep the 12-hour sessions rolling remotely.
 * Also triggers a data transfer.
 * Returns true if the message was sent, false if Watch is not reachable. */
export async function requestWatchRecording(): Promise<boolean> {
  return WatchMotionModule.requestWatchRecording();
}

/** Read all pending accelerometer sample files transferred from the Watch.
 * Files are gzip-compressed JSON arrays. Parsing happens on a background thread.
 * @returns Flattened array of all samples from all pending files. */
export async function getPendingWatchSamples(): Promise<InertialMeasurementUnitSample[]> {
  return WatchMotionModule.getPendingWatchSamples();
}

/** Delete all pending Watch transfer files after successful server upload. */
export function acknowledgeWatchSamples(): void {
  WatchMotionModule.acknowledgeWatchSamples();
}

/** A barometric altitude sample transferred from the Apple Watch. */
export interface WatchAltitudeSample {
  timestamp: string;
  altitudeM: number;
  pressureKPa?: number;
}

/** List pending Watch accelerometer transfer file names. */
export function getPendingWatchFileNames(): string[] {
  return WatchMotionModule.getPendingWatchFileNames().filter((fileName) =>
    fileName.startsWith("watch-accel-"),
  );
}

/** List pending Watch altitude transfer file names. */
export function getPendingWatchAltitudeFileNames(): string[] {
  return WatchMotionModule.getPendingWatchFileNames().filter((fileName) =>
    fileName.startsWith("watch-altitude-"),
  );
}

/** Read and parse a single pending Watch transfer file.
 * @param fileName — file name within the pending directory
 * @returns Parsed accelerometer samples from that file */
export async function readWatchFile(fileName: string): Promise<InertialMeasurementUnitSample[]> {
  return WatchMotionModule.readWatchFile(fileName);
}

/** Read and parse a single pending Watch altitude transfer file. */
export async function readWatchAltitudeFile(fileName: string): Promise<WatchAltitudeSample[]> {
  return WatchMotionModule.readWatchAltitudeFile(fileName);
}

/** Delete a single pending Watch transfer file after successful upload.
 * @param fileName — file name within the pending directory */
export function deleteWatchFile(fileName: string): void {
  WatchMotionModule.deleteWatchFile(fileName);
}

/** Get the timestamp of the last successful Watch accelerometer sync.
 * Returns null if never synced. */
export function getLastWatchSyncTimestamp(): string | null {
  return WatchMotionModule.getLastWatchSyncTimestamp();
}

/** Update the last Watch sync timestamp after a successful upload. */
export function setLastWatchSyncTimestamp(timestamp: string): void {
  WatchMotionModule.setLastWatchSyncTimestamp(timestamp);
}
