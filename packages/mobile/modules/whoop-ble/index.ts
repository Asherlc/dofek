import type { EventSubscription } from "expo-modules-core";
import WhoopBleModule from "./src/WhoopBleModule";

/** A discovered WHOOP strap */
export interface WhoopDevice {
  id: string;
  name: string | null;
}

/** A single realtime data sample from a 0x28 REALTIME_DATA packet */
export interface WhoopRealtimeDataSample {
  timestamp: string; // ISO 8601
  /** R-R interval in milliseconds (beat-to-beat timing). 0 when unavailable. */
  rrIntervalMs: number;
  quaternionW: number; // float32
  quaternionX: number;
  quaternionY: number;
  quaternionZ: number;
  /** Raw optical/PPG bytes (offsets 23-40) as hex string, 36 chars = 18 bytes */
  opticalRawHex: string;
}

/** A single IMU sample from the WHOOP strap's accelerometer + gyroscope */
export interface WhoopImuSample {
  timestamp: string; // ISO 8601
  accelerometerX: number; // raw i16
  accelerometerY: number;
  accelerometerZ: number;
  gyroscopeX: number; // raw i16
  gyroscopeY: number;
  gyroscopeZ: number;
}

/** Check whether Bluetooth is powered on and available. */
export function isBluetoothAvailable(): boolean {
  return WhoopBleModule.isBluetoothAvailable();
}

/**
 * Find an already-connected WHOOP strap.
 *
 * First checks `retrieveConnectedPeripherals` (instant) for straps already
 * connected by the WHOOP app. Falls back to a 5-second BLE scan.
 *
 * @returns The discovered WHOOP device, or null if not found.
 */
export async function findWhoop(): Promise<WhoopDevice | null> {
  return WhoopBleModule.findWhoop();
}

/**
 * Connect to a WHOOP strap by its peripheral ID.
 *
 * On iOS, multiple apps can connect to the same BLE peripheral.
 * The WHOOP app stays connected — we establish our own logical connection.
 *
 * @param peripheralId — UUID string from `findWhoop()`.
 * @returns true on success.
 */
export async function connect(peripheralId: string): Promise<boolean> {
  return WhoopBleModule.connect(peripheralId);
}

/**
 * Start real-time IMU streaming from the connected WHOOP strap.
 *
 * Sends the TOGGLE_IMU_MODE (0x6A) BLE command to the strap.
 * IMU samples (accelerometer + gyroscope) are buffered internally.
 * Call `getBufferedSamples()` to retrieve them.
 *
 * @returns true on success.
 */
export async function startImuStreaming(): Promise<boolean> {
  return WhoopBleModule.startImuStreaming();
}

/**
 * Stop IMU streaming and return the strap to normal mode.
 *
 * Sends the STOP_RAW_DATA (0x52) BLE command.
 */
export async function stopImuStreaming(): Promise<boolean> {
  return WhoopBleModule.stopImuStreaming();
}

/**
 * Send TOGGLE_REALTIME_HR (0x03) to enable continuous 1 Hz beat-interval streaming.
 *
 * Beat-interval + quaternion data arrives in REALTIME_DATA (0x28) packets at ~1 Hz.
 * This command extends streaming beyond the WHOOP app's sync window.
 * Best-effort — may be rejected by the strap if the bond doesn't support it.
 */
export async function startRealtimeHr(): Promise<boolean> {
  return WhoopBleModule.startRealtimeHr();
}

/**
 * Send TOGGLE_OPTICAL_MODE (0x6C) to enable raw optical/PPG data.
 *
 * Optical data appears in bytes 23-40 of 0x28 packets. The format is
 * partially understood — raw payloads are preserved for future analysis.
 */
export async function startOpticalMode(): Promise<boolean> {
  return WhoopBleModule.startOpticalMode();
}

/**
 * Peek at buffered IMU samples WITHOUT removing them.
 *
 * Call `confirmSamplesDrain(count)` after a successful upload to
 * actually remove them. If the upload fails, the samples remain
 * buffered for retry — no data loss.
 */
export async function peekBufferedSamples(): Promise<WhoopImuSample[]> {
  return WhoopBleModule.peekBufferedSamples();
}

/**
 * Remove the first `count` IMU samples from the buffer.
 * Call after a successful upload to commit the drain.
 */
export function confirmSamplesDrain(count: number): void {
  WhoopBleModule.confirmSamplesDrain(count);
}

/**
 * Peek at buffered realtime data (beat interval + quaternion) WITHOUT removing.
 *
 * Call `confirmRealtimeDataDrain(count)` after a successful upload.
 */
export async function peekBufferedRealtimeData(): Promise<WhoopRealtimeDataSample[]> {
  return WhoopBleModule.peekBufferedRealtimeData();
}

/**
 * Remove the first `count` realtime data samples from the buffer.
 * Call after a successful upload to commit the drain.
 */
export function confirmRealtimeDataDrain(count: number): void {
  WhoopBleModule.confirmRealtimeDataDrain(count);
}

/**
 * Retrieve and clear the internal realtime data buffer (beat interval + quaternion).
 * @deprecated Use peekBufferedRealtimeData + confirmRealtimeDataDrain instead.
 */
export async function getBufferedRealtimeData(): Promise<WhoopRealtimeDataSample[]> {
  return WhoopBleModule.getBufferedRealtimeData();
}

/**
 * Retrieve and clear the internal IMU sample buffer.
 * @deprecated Use peekBufferedSamples + confirmSamplesDrain instead.
 */
export async function getBufferedSamples(): Promise<WhoopImuSample[]> {
  return WhoopBleModule.getBufferedSamples();
}

/** Get the current BLE connection state (idle, scanning, connecting, ready, streaming). */
export function getConnectionState(): string {
  return WhoopBleModule.getConnectionState();
}

/** Get the underlying CBCentralManager Bluetooth state. */
export function getBluetoothState(): string {
  return WhoopBleModule.getBluetoothState();
}

/** Get the number of IMU samples currently buffered. */
export function getBufferedSampleCount(): number {
  return WhoopBleModule.getBufferedSampleCount();
}

/** Get BLE data path statistics for debugging. */
export function getDataPathStats(): {
  dataNotificationCount: number;
  cmdNotificationCount: number;
  totalFramesParsed: number;
  totalSamplesExtracted: number;

  emptyExtractions: number;
  bufferOverflows: number;
  packetTypes: string;
  lastCommandResponse: string;
  connectionState: string;
  hasDataCharacteristic: boolean;
  isNotifying: boolean;
  hasCmdCharacteristic: boolean;
  hasCmdResponseCharacteristic: boolean;
  lastWriteError: string;
  watchdogRetryCount: number;
} {
  return WhoopBleModule.getDataPathStats();
}

/**
 * Try to reconnect to the WHOOP strap in the background.
 *
 * Checks retrieveConnectedPeripherals first (finds straps connected by the
 * WHOOP app), then falls back to a 10-second BLE scan. Call from background
 * refresh handlers to maintain the connection.
 *
 * @returns true if a strap was found and connection initiated.
 */
export async function retryConnection(): Promise<boolean> {
  return WhoopBleModule.retryConnection();
}

/** Disconnect from the WHOOP strap. */
export function disconnect(): void {
  WhoopBleModule.disconnect();
}

/** Connection state change event from the native BLE module. */
export interface ConnectionStateEvent {
  state: string;
  peripheralId?: string;
  error?: string;
}

/**
 * Subscribe to BLE connection state changes (connected/disconnected).
 *
 * Use this to detect when the strap disconnects so the sync layer can
 * re-establish the connection on the next cycle.
 *
 * @returns A subscription that can be removed with `.remove()`.
 */
export function addConnectionStateListener(
  callback: (event: ConnectionStateEvent) => void,
): EventSubscription {
  return WhoopBleModule.addListener("onConnectionStateChanged", callback);
}

/** Real-time orientation from the Madgwick AHRS filter (quaternion + Euler angles) */
export interface OrientationEvent {
  /** Quaternion w component */
  w: number;
  /** Quaternion x component */
  x: number;
  /** Quaternion y component */
  y: number;
  /** Quaternion z component */
  z: number;
  /** Roll in degrees (-180..180) */
  roll: number;
  /** Pitch in degrees (-90..90) */
  pitch: number;
  /** Yaw in degrees (-180..180) */
  yaw: number;
}

/**
 * Subscribe to real-time orientation updates (~30 Hz).
 *
 * The Madgwick AHRS filter fuses accelerometer + gyroscope data into a
 * quaternion representing the strap's 3D orientation. Events are throttled
 * to ~30 Hz to avoid flooding the JS bridge.
 *
 * @returns A subscription that can be removed with `.remove()`.
 */
export function addOrientationListener(
  callback: (event: OrientationEvent) => void,
): EventSubscription {
  return WhoopBleModule.addListener("onOrientation", callback);
}
