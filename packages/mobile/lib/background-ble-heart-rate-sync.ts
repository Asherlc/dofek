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
let currentDeps: BleHeartRateSyncDeps | null = null;
let appStateSubscription: { remove(): void } | null = null;
let connectionStateSubscription: { remove(): void } | null = null;
let heartRateSubscription: { remove(): void } | null = null;
let periodicDrainTimer: ReturnType<typeof setInterval> | null = null;
let bluetoothAvailabilityTimer: ReturnType<typeof setInterval> | null = null;
let activeDrain: Promise<void> | null = null;

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

async function drainBuffer(
  uploadClient: BleHeartRateUploadClient,
  deps: BleHeartRateSyncDeps,
): Promise<void> {
  const deviceErasureCutoff = await loadDeviceErasureCutoff();

  for (;;) {
    const samples = await deps.peekBufferedSamples(UPLOAD_BATCH_SIZE);
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
      await uploadClient.bleHeartRateSync.pushSamples.mutate({
        deviceId,
        samples: deviceSamples,
      });
    }

    deps.confirmSamplesDrain(samples.length);
    logger.info(LOG_CATEGORY, `uploaded ${samples.length} buffered samples`);
  }
}

function runSerializedDrain(
  uploadClient: BleHeartRateUploadClient,
  deps: BleHeartRateSyncDeps,
): Promise<void> {
  if (activeDrain) return activeDrain;

  const trackedDrain = drainBuffer(uploadClient, deps).finally(() => {
    if (activeDrain === trackedDrain) activeDrain = null;
  });
  activeDrain = trackedDrain;
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

function startForegroundTimers(
  uploadClient: BleHeartRateUploadClient,
  deps: BleHeartRateSyncDeps,
): void {
  if (AppState.currentState !== "active") return;

  updateBluetoothAvailability(deps);
  if (!periodicDrainTimer) {
    periodicDrainTimer = setInterval(() => {
      void runSerializedDrain(uploadClient, deps).catch((error: unknown) => {
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
  currentDeps = deps;

  connectionStateSubscription = deps.addConnectionStateListener((event) => {
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
    publishState({ liveBpm: sample.heartRateBpm });
  });
  appStateSubscription = AppState.addEventListener("change", (nextState: AppStateStatus) => {
    if (nextState !== "active") {
      stopForegroundTimers();
      return;
    }

    startForegroundTimers(uploadClient, deps);
    void runSerializedDrain(uploadClient, deps).catch((error: unknown) => {
      captureException(error, { source: "ble-heart-rate-foreground-drain" });
    });
  });

  startForegroundTimers(uploadClient, deps);
  if (AppState.currentState === "active") {
    try {
      await runSerializedDrain(uploadClient, deps);
    } catch (error: unknown) {
      captureException(error, { source: "ble-heart-rate-initial-drain" });
    }
  }
}

/** Connect the first advertising standard heart-rate monitor. */
export async function connectBleHeartRateMonitor(): Promise<void> {
  if (!currentDeps) throw new Error("Bluetooth heart-rate sync is not initialized");

  publishState({ connectionState: "connecting", liveBpm: null });
  try {
    const device = await currentDeps.scanAndConnect();
    publishState({ connectionState: "connected", device });
  } catch (error: unknown) {
    publishState({ connectionState: "disconnected", device: null, liveBpm: null });
    throw error;
  }
}

/** Stop capture from the currently connected monitor. */
export function disconnectBleHeartRateMonitor(): void {
  currentDeps?.disconnect();
  publishState({ connectionState: "disconnected", device: null, liveBpm: null });
}

/** Flush buffered samples during an iOS background-refresh wakeup. */
export async function syncBleHeartRate(
  uploadClient: BleHeartRateUploadClient,
  deps: BleHeartRateSyncDeps,
): Promise<void> {
  try {
    await runSerializedDrain(uploadClient, deps);
  } catch (error: unknown) {
    captureException(error, { source: "ble-heart-rate-background-refresh" });
    throw error;
  }
}

/** Stop the authenticated BLE heart-rate lifecycle and release its connection. */
export function teardownBackgroundBleHeartRateSync(): void {
  stopForegroundTimers();
  appStateSubscription?.remove();
  connectionStateSubscription?.remove();
  heartRateSubscription?.remove();
  appStateSubscription = null;
  connectionStateSubscription = null;
  heartRateSubscription = null;
  currentDeps?.disconnect();
  currentDeps = null;
  activeDrain = null;
  publishState({
    bluetoothAvailable: false,
    connectionState: "disconnected",
    device: null,
    liveBpm: null,
  });
}
