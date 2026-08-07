import type { InertialMeasurementUnitSample } from "@dofek/imu";
import { z } from "zod";
import type { WatchAltitudeSample } from "./schemas";
import { WatchAltitudeSampleSchema } from "./schemas";
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

/** Re-enable Watch recording and transfer only after a new account authenticates. */
export async function enableAccountSync(): Promise<boolean> {
  return WatchMotionModule.enableAccountSync();
}

function isSafePendingFileName(fileName: string): boolean {
  if (!fileName) return false;
  if (fileName.includes("..")) return false;
  if (fileName.includes("/") || fileName.includes("\\")) return false;
  return fileName === fileName.split(/[/\\]/).pop();
}

/** List pending Watch accelerometer transfer file names. */
export function getPendingWatchFileNames(): string[] {
  return WatchMotionModule.getPendingWatchFileNames().filter((fileName: string) =>
    fileName.startsWith("watch-accel-"),
  );
}

/** List pending Watch altitude transfer file names. */
export function getPendingWatchAltitudeFileNames(): string[] {
  return WatchMotionModule.getPendingWatchFileNames().filter((fileName: string) =>
    fileName.startsWith("watch-altitude-"),
  );
}

/** Read and parse a single pending Watch transfer file.
 * @param fileName — file name within the pending directory
 * @returns Parsed accelerometer samples from that file */
export async function readWatchFile(fileName: string): Promise<InertialMeasurementUnitSample[]> {
  if (!isSafePendingFileName(fileName)) {
    throw new Error(`Invalid pending watch file name: ${fileName}`);
  }
  return WatchMotionModule.readWatchFile(fileName);
}

/** Read and parse a single pending Watch altitude transfer file. */
export async function readWatchAltitudeFile(fileName: string): Promise<WatchAltitudeSample[]> {
  if (!isSafePendingFileName(fileName)) {
    throw new Error(`Invalid pending watch file name: ${fileName}`);
  }
  const raw = await WatchMotionModule.readWatchAltitudeFile(fileName);
  return z.array(WatchAltitudeSampleSchema).parse(raw);
}

/** Delete a single pending Watch transfer file after successful upload.
 * @param fileName — file name within the pending directory */
export function deleteWatchFile(fileName: string): void {
  if (!isSafePendingFileName(fileName)) {
    throw new Error(`Invalid pending watch file name: ${fileName}`);
  }
  WatchMotionModule.deleteWatchFile(fileName);
}

/** Delete iPhone-side pending files, disable account sync, and request Watch-side purge. */
export async function purgeAccountState(deviceErasureCutoff: string): Promise<boolean> {
  return WatchMotionModule.purgeAccountState(deviceErasureCutoff);
}
