import * as Sentry from "@sentry/react-native";
import { useEffect } from "react";
import {
  initBackgroundWhoopBleSync,
  teardownBackgroundWhoopBleSync,
  type WhoopBleRealtimeUploadClient,
  type WhoopBleSyncDeps,
} from "./background-whoop-ble-sync";
import type { InertialMeasurementUnitUploadClient } from "./inertial-measurement-unit-service";

/**
 * Hook that starts WHOOP BLE sync for all available data streams:
 * - IMU (accelerometer + gyroscope) from R21/R33/R34 packets
 * - Realtime HR + quaternion from 0x28 packets
 * - Optical/PPG data (raw payload preserved for future analysis)
 *
 * Always connects to the WHOOP strap if one is available — BLE scanning
 * with specific service UUIDs is power-efficient on iOS (hardware-filtered).
 * Sends TOGGLE_REALTIME_HR and TOGGLE_OPTICAL_MODE on connection to maximize data capture.
 *
 * Must be rendered inside a tRPC provider.
 */
export function useWhoopBleSync(
  uploadClient: InertialMeasurementUnitUploadClient,
  whoopDeps: WhoopBleSyncDeps,
  realtimeClient?: WhoopBleRealtimeUploadClient,
): void {
  useEffect(() => {
    initBackgroundWhoopBleSync(uploadClient, whoopDeps, realtimeClient).catch((error: unknown) => {
      Sentry.captureException(error, { tags: { source: "whoop-ble-sync-init" } });
    });

    return () => {
      teardownBackgroundWhoopBleSync();
    };
  }, [uploadClient, whoopDeps, realtimeClient]);
}
