import type { EventSubscription } from "expo-modules-core";
import { z } from "zod";
import WhoopBleModule from "./src/WhoopBleModule";

/** A discovered WHOOP strap */
export interface WhoopDevice {
  id: string;
  name: string | null;
}

/** A read-only snapshot of the current WHOOP connection and buffer state. */
export const WhoopDeviceSummarySchema = z.object({
  id: z.string().nullable(),
  name: z.string().nullable(),
  connectionState: z.string().min(1),
  imuBufferedSamples: z.number().int().nonnegative(),
  realtimeBufferedSamples: z.number().int().nonnegative(),
});

export type WhoopDeviceSummary = z.infer<typeof WhoopDeviceSummarySchema>;

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
 * IMU samples are committed to the native durable upload queue.
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

/** Get the current WHOOP identity, connection state, and buffer counts without scanning or connecting. */
export function getDeviceSummary(): WhoopDeviceSummary {
  return WhoopDeviceSummarySchema.parse(WhoopBleModule.getDeviceSummary());
}

const DiagnosticCountSchema = z.number().int().nonnegative();
const DiagnosticTimestampSchema = z.iso.datetime({ offset: true });

const WhoopBufferStreamDiagnosticsSchema = z.object({
  count: DiagnosticCountSchema,
  oldestTimestamp: DiagnosticTimestampSchema.nullable(),
  newestTimestamp: DiagnosticTimestampSchema.nullable(),
  receivedCount: DiagnosticCountSchema,
  confirmedCount: DiagnosticCountSchema,
  overflowDiscardedCount: DiagnosticCountSchema,
  erasureDiscardedCount: DiagnosticCountSchema,
  clearedCount: DiagnosticCountSchema,
  legacyDrainedCount: DiagnosticCountSchema,
  lastConfirmedAt: DiagnosticTimestampSchema.nullable(),
});

export type WhoopBufferStreamDiagnostics = z.infer<typeof WhoopBufferStreamDiagnosticsSchema>;

const WhoopBufferCheckpointSchema = z.object({
  bufferInstanceId: z.uuid(),
  bufferCreatedAt: DiagnosticTimestampSchema,
  checkpointAt: DiagnosticTimestampSchema,
  imu: WhoopBufferStreamDiagnosticsSchema,
  realtime: WhoopBufferStreamDiagnosticsSchema,
});

const WhoopConnectionEventSchema = z.object({
  eventId: z.uuid(),
  occurredAt: DiagnosticTimestampSchema,
  nativeSessionId: z.uuid(),
  processId: z.number().int().positive(),
  event: z.string().min(1),
  connectionState: z.string().min(1),
  centralState: z.string().min(1),
  reconnectIntent: z.boolean(),
  peripheralId: z.string().optional(),
  errorDomain: z.string().optional(),
  errorCode: z.number().int().optional(),
  errorDescription: z.string().optional(),
  reason: z.string().optional(),
  previousConnectionState: z.string().optional(),
  restoredPeripheralCount: DiagnosticCountSchema.optional(),
});

const WhoopDataPathStatsSchema = z.object({
  connectionDiagnostics: z.object({
    events: z.array(WhoopConnectionEventSchema).max(64),
    overflowCount: DiagnosticCountSchema,
  }),
  dataNotificationCount: DiagnosticCountSchema,
  cmdNotificationCount: DiagnosticCountSchema,
  totalFramesParsed: DiagnosticCountSchema,
  totalSamplesExtracted: DiagnosticCountSchema,

  emptyExtractions: DiagnosticCountSchema,
  bufferOverflows: DiagnosticCountSchema,
  packetTypes: z.string(),
  lastCommandResponse: z.string(),
  connectionState: z.string().min(1),
  lastKnownDeviceId: z.string().nullable(),
  hasDataCharacteristic: z.boolean(),
  isNotifying: z.boolean(),
  hasCmdCharacteristic: z.boolean(),
  hasCmdResponseCharacteristic: z.boolean(),
  lastWriteError: z.string(),
  watchdogRetryCount: DiagnosticCountSchema,
  malformedFrames: DiagnosticCountSchema,
  malformedCmdFrames: DiagnosticCountSchema,
  coalescedFrames: DiagnosticCountSchema,
  coalescedCmdFrames: DiagnosticCountSchema,
  realtimeBufferCount: DiagnosticCountSchema,
  lastDataNotificationAt: DiagnosticTimestampSchema.nullable(),
  lastParsedImuAt: DiagnosticTimestampSchema.nullable(),
  lastParsedRealtimeAt: DiagnosticTimestampSchema.nullable(),
  /** Latest device timestamp with a positive reported heart rate, not receipt time. */
  lastValidHeartRateAt: DiagnosticTimestampSchema.nullable(),
  buffers: WhoopBufferCheckpointSchema.extend({
    activeUploadCount: DiagnosticCountSchema,
    blockedUploadStreams: z.array(z.enum(["imu", "realtime"])),
    lastUploadError: z.string().nullable(),
  }),
});

export type WhoopDataPathStats = z.infer<typeof WhoopDataPathStatsSchema>;

/** Get BLE capture, queue, discard, and prior-checkpoint metadata. */
export function getDataPathStats(): WhoopDataPathStats {
  return WhoopDataPathStatsSchema.parse(WhoopBleModule.getDataPathStats());
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

/** Disconnect and clear every account-owned IMU/realtime buffer and parser state. */
export async function purgeAccountState(deviceErasureCutoff: string): Promise<boolean> {
  return WhoopBleModule.purgeAccountState(deviceErasureCutoff);
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

/** Subscribe to WHOOP identity, connection, streaming, and buffer snapshot changes. */
export function addDeviceStateListener(
  callback: (summary: WhoopDeviceSummary) => void,
): EventSubscription {
  return WhoopBleModule.addListener("onDeviceStateChanged", (event: unknown) =>
    callback(WhoopDeviceSummarySchema.parse(event)),
  );
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

export interface WhoopUploadContext {
  userId: string;
  serverURL: string;
  token: string;
  headers: Record<string, string>;
}

/** Configure account-bound native delivery before starting capture. */
export function configureUpload(context: WhoopUploadContext): void {
  WhoopBleModule.configureUpload(context);
}

/** Schedule bounded delivery of queued samples through iOS. */
export function flushUploads(): void {
  WhoopBleModule.flushUploads();
}

/** Synchronously revoke delivery and purge the signed-out account's queue. */
export function disableUploads(): void {
  WhoopBleModule.disableUploads();
}

/** Observe storage failures that stop native capture. */
export function addCaptureErrorListener(
  callback: (event: { message: string }) => void,
): EventSubscription {
  return WhoopBleModule.addListener("onCaptureError", callback);
}
