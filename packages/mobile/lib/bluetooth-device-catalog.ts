import {
  addDeviceListListener,
  addDeviceStateListener,
  type BleHeartRateDeviceSnapshot,
  getDevices as getHeartRateDevices,
} from "../modules/ble-heart-rate";
import {
  addDeviceStateListener as addWhoopDeviceStateListener,
  getDeviceSummary as getWhoopDeviceSummary,
  type WhoopDeviceSummary,
} from "../modules/whoop-ble";
import { captureException } from "./telemetry";

export interface HeartRateDiagnostics {
  bufferedSampleCount: number;
  lastHeartRateBpm: number | null;
  lastMeasurementAt: string | null;
  lastRrIntervalsMs: number[];
}

export interface WhoopDiagnostics {
  imuBufferedSamples: number;
  realtimeBufferedSamples: number;
}

export type BluetoothDevice =
  | {
      id: "whoop";
      kind: "whoop";
      name: string;
      peripheralId: string | null;
      connectionState: string;
      diagnostics: WhoopDiagnostics;
    }
  | {
      id: string;
      kind: "heart-rate";
      name: string;
      connectionState: string;
      diagnostics: HeartRateDiagnostics;
    };

export interface BluetoothDeviceSubscription {
  remove(): void;
}

export type BluetoothDeviceCatalogUpdate =
  | { state: "ready"; devices: BluetoothDevice[]; error: null }
  | { state: "error"; devices: []; error: string };

function toWhoopDevice(summary: WhoopDeviceSummary): BluetoothDevice {
  return {
    id: "whoop",
    kind: "whoop",
    name: summary.name ?? "WHOOP",
    peripheralId: summary.id,
    connectionState: summary.connectionState,
    diagnostics: {
      imuBufferedSamples: summary.imuBufferedSamples,
      realtimeBufferedSamples: summary.realtimeBufferedSamples,
    },
  };
}

function toHeartRateDevice(snapshot: BleHeartRateDeviceSnapshot): BluetoothDevice {
  return {
    id: snapshot.id,
    kind: "heart-rate",
    name: snapshot.name ?? "Heart-rate monitor",
    connectionState: snapshot.connectionState,
    diagnostics: {
      bufferedSampleCount: snapshot.bufferedSampleCount,
      lastHeartRateBpm: snapshot.lastHeartRateBpm,
      lastMeasurementAt: snapshot.lastMeasurementAt,
      lastRrIntervalsMs: snapshot.lastRrIntervalsMs,
    },
  };
}

export async function getBluetoothDevices(): Promise<BluetoothDevice[]> {
  const heartRateDevices = await getHeartRateDevices();
  return [toWhoopDevice(getWhoopDeviceSummary()), ...heartRateDevices.map(toHeartRateDevice)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function subscribeBluetoothDevices(
  listener: (update: BluetoothDeviceCatalogUpdate) => void,
): BluetoothDeviceSubscription {
  let isActive = true;
  const publish = async () => {
    try {
      const devices = await getBluetoothDevices();
      if (isActive) {
        listener({ state: "ready", devices, error: null });
      }
    } catch (error) {
      captureException(error, { source: "bluetooth-device-catalog-subscription" });
      if (isActive) {
        listener({ state: "error", devices: [], error: errorMessage(error) });
      }
    }
  };

  const heartRateSubscription = addDeviceStateListener(() => void publish());
  const heartRateListSubscription = addDeviceListListener(() => void publish());
  const whoopSubscription = addWhoopDeviceStateListener(() => void publish());

  return {
    remove() {
      isActive = false;
      heartRateSubscription.remove();
      heartRateListSubscription.remove();
      whoopSubscription.remove();
    },
  };
}
