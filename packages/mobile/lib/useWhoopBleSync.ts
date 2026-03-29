import * as Sentry from "@sentry/react-native";
import { useEffect } from "react";
import {
  initBackgroundWhoopBleSync,
  teardownBackgroundWhoopBleSync,
  type WhoopBleSyncDeps,
} from "./background-whoop-ble-sync";
import type { InertialMeasurementUnitUploadClient } from "./inertial-measurement-unit-service";

/**
 * Hook that starts WHOOP BLE accelerometer sync.
 *
 * Always connects to the WHOOP strap if one is available — BLE scanning
 * with specific service UUIDs is power-efficient on iOS (hardware-filtered).
 * R21 raw IMU data flows passively during the WHOOP app's sync, and
 * TOGGLE_IMU_MODE enables continuous streaming beyond sync sessions.
 *
 * Must be rendered inside a tRPC provider.
 */
export function useWhoopBleSync(
  uploadClient: InertialMeasurementUnitUploadClient,
  whoopDeps: WhoopBleSyncDeps,
): void {
  useEffect(() => {
    initBackgroundWhoopBleSync(uploadClient, whoopDeps).catch((error: unknown) => {
      Sentry.captureException(error, { tags: { source: "whoop-ble-sync-init" } });
    });

    return () => {
      teardownBackgroundWhoopBleSync();
    };
  }, [uploadClient, whoopDeps]);
}
