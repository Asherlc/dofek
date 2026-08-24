import {
  addDeviceStateListener,
  type BleHeartRateDeviceSnapshot,
  getDevices as getHeartRateDevices,
} from "../modules/ble-heart-rate";
import {
  addConnectionStateListener as addWhoopConnectionStateListener,
  getDeviceSummary as getWhoopDeviceSummary,
  type WhoopDeviceSummary,
} from "../modules/whoop-ble";

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
      id: string;
      kind: "whoop";
      name: string;
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

function toWhoopDevice(summary: WhoopDeviceSummary): BluetoothDevice {
  return {
    id: summary.id ?? "whoop",
    kind: "whoop",
    name: summary.name ?? "WHOOP",
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

export function subscribeBluetoothDevices(
  listener: (devices: BluetoothDevice[]) => void,
): BluetoothDeviceSubscription {
  let isActive = true;
  const publish = () => {
    void getBluetoothDevices().then((devices) => {
      if (isActive) {
        listener(devices);
      }
    });
  };

  const heartRateSubscription = addDeviceStateListener(publish);
  const whoopSubscription = addWhoopConnectionStateListener(publish);

  return {
    remove() {
      isActive = false;
      heartRateSubscription.remove();
      whoopSubscription.remove();
    },
  };
}
