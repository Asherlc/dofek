import type { InertialMeasurementUnitSample } from "@dofek/imu";
import type { WhoopRealtimeDataSample } from "../modules/whoop-ble";
import type { DeviceScopedSample } from "./device-sample-groups";
import type { WhoopCaptureStats, WhoopUploadBatch } from "./whoop-ble-diagnostics";

/** tRPC client interface for passive WHOOP IMU sample upload. */
export interface InertialMeasurementUnitUploadClient {
  inertialMeasurementUnitSync: {
    pushSamples: {
      mutate(input: {
        deviceId: string;
        deviceType: string;
        samples: InertialMeasurementUnitSample[];
        telemetry?: WhoopUploadBatch["telemetry"];
      }): Promise<{ inserted: number }>;
    };
  };
}

type BufferedInertialMeasurementUnitSample = InertialMeasurementUnitSample & DeviceScopedSample;
type RealtimeDataSample = WhoopRealtimeDataSample;

/** Dependencies injected for testability (wraps the whoop-ble native module) */
export interface WhoopBleSyncDeps {
  getDataPathStats(): WhoopCaptureStats;
  isBluetoothAvailable(): boolean;
  findWhoop(): Promise<{ id: string; name: string | null } | null>;
  connect(peripheralId: string): Promise<boolean>;
  startImuStreaming(): Promise<boolean>;
  stopImuStreaming(): Promise<boolean>;
  peekBufferedSamples(maxCount?: number): Promise<BufferedInertialMeasurementUnitSample[]>;
  confirmSamplesDrain(count: number): void;
  peekBufferedRealtimeData(maxCount?: number): Promise<RealtimeDataSample[]>;
  confirmRealtimeDataDrain(count: number): void;
  addConnectionStateListener(
    callback: (event: { state: string; peripheralId?: string; error?: string }) => void,
  ): { remove(): void };
  disconnect(): void;
}

/** tRPC client interface for BLE realtime data upload (heart rate + beat interval + orientation + optical) */
export interface WhoopBleRealtimeUploadClient {
  whoopBleSync: {
    pushRealtimeData: {
      mutate(input: {
        deviceId: string;
        samples: Array<Omit<WhoopRealtimeDataSample, "deviceId">>;
        telemetry?: WhoopUploadBatch["telemetry"];
      }): Promise<{ inserted: number }>;
    };
  };
}
