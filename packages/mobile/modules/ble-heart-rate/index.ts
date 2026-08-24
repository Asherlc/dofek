import type { EventSubscription } from "expo-modules-core";
import BleHeartRateModule from "./src/BleHeartRateModule";

/** A discovered / connected Bluetooth heart-rate monitor. */
export interface BleHeartRateDevice {
  id: string;
  name: string | null;
}

/** Persisted state and latest native measurement for a heart-rate monitor. */
export interface BleHeartRateDeviceSnapshot {
  id: string;
  name: string | null;
  connectionState: string;
  lastMeasurementAt: string | null;
  lastHeartRateBpm: number | null;
  lastRrIntervalsMs: number[];
  bufferedSampleCount: number;
}

/**
 * A single heart-rate notification.
 *
 * `heartRateBpm` is the value from the Heart Rate Measurement characteristic
 * (0x2A37); `rrIntervalsMs` carries the optional beat-to-beat intervals from the
 * same notification (empty when the strap does not report them).
 */
export interface BleHeartRateSample {
  deviceId?: string;
  timestamp: string; // ISO 8601
  heartRateBpm: number;
  rrIntervalsMs: number[];
}

/** Check whether Bluetooth is powered on and available. */
export function isBluetoothAvailable(): boolean {
  return BleHeartRateModule.isBluetoothAvailable();
}

/**
 * Scan for a Bluetooth heart-rate monitor and connect to the first one found.
 *
 * Resolves with the connected device once the Heart Rate Measurement
 * characteristic is subscribed. Rejects if no monitor is found or the
 * connection fails.
 */
export async function scanAndConnect(): Promise<BleHeartRateDevice> {
  return BleHeartRateModule.scanAndConnect();
}

/**
 * Reconnect to a previously discovered monitor by its peripheral ID.
 *
 * @param peripheralId — UUID string from a prior {@link scanAndConnect}.
 */
export async function connect(peripheralId: string): Promise<BleHeartRateDevice> {
  return BleHeartRateModule.connect(peripheralId);
}

/** List the app-managed Bluetooth heart-rate monitors and their native state. */
export function getDevices(): BleHeartRateDeviceSnapshot[] {
  return BleHeartRateModule.getDevices();
}

/** Get the current BLE connection state (idle, scanning, connecting, ready). */
export function getConnectionState(): string {
  return BleHeartRateModule.getConnectionState();
}

/** Get the number of heart-rate samples currently buffered. */
export function getBufferedSampleCount(): number {
  return BleHeartRateModule.getBufferedSampleCount();
}

/**
 * Peek at buffered heart-rate samples WITHOUT removing them.
 *
 * Call {@link confirmSamplesDrain} after a successful upload to remove them. If
 * the upload fails, the samples remain buffered for retry — no data loss.
 */
export async function peekBufferedSamples(maxCount?: number): Promise<BleHeartRateSample[]> {
  return BleHeartRateModule.peekBufferedSamples(maxCount);
}

/**
 * Remove the first `count` samples from the buffer.
 * Call after a successful upload to commit the drain.
 */
export function confirmSamplesDrain(count: number): void {
  BleHeartRateModule.confirmSamplesDrain(count);
}

/** Disconnect the current monitor, or a persisted monitor when specified. */
export function disconnect(): void;
export function disconnect(peripheralId: string): void;
export function disconnect(peripheralId?: string): void {
  if (peripheralId === undefined) {
    BleHeartRateModule.disconnect();
    return;
  }
  BleHeartRateModule.disconnect(peripheralId);
}

/** Forget one persisted monitor. */
export function forget(peripheralId: string): void {
  BleHeartRateModule.forget(peripheralId);
}

/** Disconnect and clear buffered heart-rate samples for the deleted account. */
export async function purgeAccountState(deviceErasureCutoff: string): Promise<boolean> {
  return BleHeartRateModule.purgeAccountState(deviceErasureCutoff);
}

/** Connection state change event from the native BLE module. */
export interface ConnectionStateEvent {
  state: string;
  peripheralId?: string;
  name?: string;
  error?: string;
}

/**
 * Subscribe to BLE connection state changes (connected/disconnected).
 *
 * @returns A subscription that can be removed with `.remove()`.
 */
export function addConnectionStateListener(
  callback: (event: ConnectionStateEvent) => void,
): EventSubscription {
  return BleHeartRateModule.addListener("onConnectionStateChanged", callback);
}

/** Subscribe to a persisted monitor's latest native snapshot. */
export function addDeviceStateListener(
  callback: (snapshot: BleHeartRateDeviceSnapshot) => void,
): EventSubscription {
  return BleHeartRateModule.addListener("onDeviceStateChanged", callback);
}

/**
 * Subscribe to live heart-rate measurements for the UI (~1 Hz).
 *
 * @returns A subscription that can be removed with `.remove()`.
 */
export function addHeartRateListener(
  callback: (event: BleHeartRateSample) => void,
): EventSubscription {
  return BleHeartRateModule.addListener("onHeartRateMeasurement", callback);
}
