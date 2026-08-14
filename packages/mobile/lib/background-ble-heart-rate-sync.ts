import { AppState, type AppStateStatus } from "react-native";
import type {
  BleHeartRateDevice,
  BleHeartRateSample,
  ConnectionStateEvent,
} from "../modules/ble-heart-rate";
import { isAfterDeviceErasureCutoff, loadDeviceErasureCutoff } from "./device-erasure-cutoff";
import { DeviceSampleGroups } from "./device-sample-groups.ts";
import { captureException, logger } from "./telemetry";

const LOG_CATEGORY = "ble-heart-rate";
const UPLOAD_BATCH_SIZE = 500;
const PERIODIC_DRAIN_INTERVAL_MS = 30_000;
const BLUETOOTH_AVAILABILITY_INTERVAL_MS = 2_000;
const DEFAULT_DEVICE_ID = "Heart Rate Monitor";

type HeartRateConnectionState = "disconnected" | "connecting" | "connected";

export interface BleHeartRateSyncState {
  bluetoothAvailable: boolean;
  connectionState: HeartRateConnectionState;
  device: BleHeartRateDevice | null;
  liveBpm: number | null;
}

export interface BleHeartRateSyncDeps {
  isBluetoothAvailable(): boolean;
  scanAndConnect(): Promise<BleHeartRateDevice>;
  peekBufferedSamples(maxCount?: number): Promise<BleHeartRateSample[]>;
  confirmSamplesDrain(count: number): void;
  clearBufferedSamples(): void;
  addConnectionStateListener(callback: (event: ConnectionStateEvent) => void): {
    remove(): void;
  };
  addHeartRateListener(callback: (event: BleHeartRateSample) => void): {
    remove(): void;
  };
  disconnect(): void;
}

export interface BleHeartRateUploadClient {
  bleHeartRateSync: {
    pushSamples: {
      mutate(input: {
        deviceId: string;
        samples: BleHeartRateSample[];
      }): Promise<{ inserted: number }>;
    };
  };
}

const listeners = new Set<() => void>();
let state: BleHeartRateSyncState = {
  bluetoothAvailable: false,
  connectionState: "disconnected",
  device: null,
  liveBpm: null,
};
let appStateSubscription: { remove(): void } | null = null;
let connectionStateSubscription: { remove(): void } | null = null;
let heartRateSubscription: { remove(): void } | null = null;
let periodicDrainTimer: ReturnType<typeof setInterval> | null = null;
let bluetoothAvailabilityTimer: ReturnType<typeof setInterval> | null = null;

interface BleHeartRateSyncSession {
  uploadClient: BleHeartRateUploadClient;
  deps: BleHeartRateSyncDeps;
  activeDrain: Promise<void> | null;
}

let currentSession: BleHeartRateSyncSession | null = null;

function publishState(next: Partial<BleHeartRateSyncState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function getBleHeartRateSyncState(): BleHeartRateSyncState {
  return state;
}

export function subscribeBleHeartRateSyncState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function toUploadSample(sample: BleHeartRateSample): BleHeartRateSample {
  return {
    timestamp: sample.timestamp,
    heartRateBpm: sample.heartRateBpm,
    rrIntervalsMs: sample.rrIntervalsMs,
  };
}

function isCurrentSession(session: BleHeartRateSyncSession): boolean {
  return currentSession === session;
}

async function drainBuffer(session: BleHeartRateSyncSession): Promise<void> {
  const { uploadClient, deps } = session;
  const deviceErasureCutoff = await loadDeviceErasureCutoff();
  if (!isCurrentSession(session)) return;

  for (;;) {
    const samples = await deps.peekBufferedSamples(UPLOAD_BATCH_SIZE);
    if (!isCurrentSession(session)) return;
    if (samples.length === 0) return;

    const uploadableSamples =
      deviceErasureCutoff === null
        ? samples
        : samples.filter((sample) =>
            isAfterDeviceErasureCutoff(sample.timestamp, deviceErasureCutoff),
          );
    const groups = new DeviceSampleGroups(state.device?.id ?? DEFAULT_DEVICE_ID, toUploadSample);
    for (const sample of uploadableSamples) groups.add(sample);

    for (const [deviceId, deviceSamples] of groups.entries()) {
      if (!isCurrentSession(session)) return;
      await uploadClient.bleHeartRateSync.pushSamples.mutate({
        deviceId,
        samples: deviceSamples,
      });
      if (!isCurrentSession(session)) return;
    }

    if (!isCurrentSession(session)) return;
    deps.confirmSamplesDrain(samples.length);
    logger.info(LOG_CATEGORY, `uploaded ${samples.length} buffered samples`);
  }
}

function runSerializedDrain(session: BleHeartRateSyncSession): Promise<void> {
  if (!isCurrentSession(session)) return Promise.resolve();
  if (session.activeDrain) return session.activeDrain;

  const trackedDrain = drainBuffer(session).finally(() => {
    if (session.activeDrain === trackedDrain) session.activeDrain = null;
  });
  session.activeDrain = trackedDrain;
  return trackedDrain;
}

function updateBluetoothAvailability(deps: BleHeartRateSyncDeps): void {
  publishState({ bluetoothAvailable: deps.isBluetoothAvailable() });
}

function stopForegroundTimers(): void {
  if (periodicDrainTimer) {
    clearInterval(periodicDrainTimer);
    periodicDrainTimer = null;
  }
  if (bluetoothAvailabilityTimer) {
    clearInterval(bluetoothAvailabilityTimer);
    bluetoothAvailabilityTimer = null;
  }
}

function startForegroundTimers(session: BleHeartRateSyncSession): void {
  const { deps } = session;
  if (!isCurrentSession(session) || AppState.currentState !== "active") return;

  updateBluetoothAvailability(deps);
  if (!periodicDrainTimer) {
    periodicDrainTimer = setInterval(() => {
      void runSerializedDrain(session).catch((error: unknown) => {
        captureException(error, { source: "ble-heart-rate-periodic-drain" });
      });
    }, PERIODIC_DRAIN_INTERVAL_MS);
  }
  if (!bluetoothAvailabilityTimer) {
    bluetoothAvailabilityTimer = setInterval(() => {
      updateBluetoothAvailability(deps);
    }, BLUETOOTH_AVAILABILITY_INTERVAL_MS);
  }
}

/**
 * Starts the recorder-independent BLE heart-rate lifecycle for an authenticated
 * session. Pairing remains user initiated; once connected, native buffering
 * continues in the background and this service uploads whenever iOS runs JS.
 */
export async function initBackgroundBleHeartRateSync(
  uploadClient: BleHeartRateUploadClient,
  deps: BleHeartRateSyncDeps,
): Promise<void> {
  teardownBackgroundBleHeartRateSync();
  deps.clearBufferedSamples();
  const session: BleHeartRateSyncSession = { uploadClient, deps, activeDrain: null };
  currentSession = session;

  connectionStateSubscription = deps.addConnectionStateListener((event) => {
    if (!isCurrentSession(session)) return;
    if (event.state === "connected") {
      publishState({
        connectionState: "connected",
        device: {
          id: event.peripheralId ?? state.device?.id ?? DEFAULT_DEVICE_ID,
          name: event.name ?? state.device?.name ?? null,
        },
      });
      return;
    }
    if (event.state === "disconnected") {
      publishState({ connectionState: "disconnected", device: null, liveBpm: null });
    }
  });
  heartRateSubscription = deps.addHeartRateListener((sample) => {
    if (!isCurrentSession(session)) return;
    publishState({ liveBpm: sample.heartRateBpm });
  });
  appStateSubscription = AppState.addEventListener("change", (nextState: AppStateStatus) => {
    if (!isCurrentSession(session)) return;
    if (nextState !== "active") {
      stopForegroundTimers();
      return;
    }

    startForegroundTimers(session);
    void runSerializedDrain(session).catch((error: unknown) => {
      captureException(error, { source: "ble-heart-rate-foreground-drain" });
    });
  });

  startForegroundTimers(session);
  if (AppState.currentState === "active") {
    try {
      await runSerializedDrain(session);
    } catch (error: unknown) {
      captureException(error, { source: "ble-heart-rate-initial-drain" });
    }
  }
}

/** Connect the first advertising standard heart-rate monitor. */
export async function connectBleHeartRateMonitor(): Promise<void> {
  const session = currentSession;
  if (!session) throw new Error("Bluetooth heart-rate sync is not initialized");

  publishState({ connectionState: "connecting", liveBpm: null });
  try {
    const device = await session.deps.scanAndConnect();
    if (!isCurrentSession(session)) {
      session.deps.disconnect();
      return;
    }
    publishState({ connectionState: "connected", device });
  } catch (error: unknown) {
    if (!isCurrentSession(session)) return;
    publishState({ connectionState: "disconnected", device: null, liveBpm: null });
    throw error;
  }
}

/** Stop capture from the currently connected monitor. */
export function disconnectBleHeartRateMonitor(): void {
  currentSession?.deps.disconnect();
  publishState({ connectionState: "disconnected", device: null, liveBpm: null });
}

/** Flush buffered samples during an iOS background-refresh wakeup. */
export async function syncBleHeartRate(): Promise<void> {
  const session = currentSession;
  if (!session) return;
  try {
    await runSerializedDrain(session);
  } catch (error: unknown) {
    captureException(error, { source: "ble-heart-rate-background-refresh" });
    throw error;
  }
}

/** Stop the authenticated BLE heart-rate lifecycle and release its connection. */
export function teardownBackgroundBleHeartRateSync(): void {
  const endingSession = currentSession;
  currentSession = null;
  stopForegroundTimers();
  appStateSubscription?.remove();
  connectionStateSubscription?.remove();
  heartRateSubscription?.remove();
  appStateSubscription = null;
  connectionStateSubscription = null;
  heartRateSubscription = null;
  endingSession?.deps.disconnect();
  endingSession?.deps.clearBufferedSamples();
  publishState({
    bluetoothAvailable: false,
    connectionState: "disconnected",
    device: null,
    liveBpm: null,
  });
}
