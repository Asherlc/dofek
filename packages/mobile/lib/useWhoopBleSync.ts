import { useEffect } from "react";
import { Alert } from "react-native";
import {
  initBackgroundWhoopBleSync,
  teardownBackgroundWhoopBleSync,
} from "./background-whoop-ble-sync";
import { captureException } from "./telemetry";
import type { WhoopBleSyncDeps, WhoopUploadContext } from "./whoop-ble-sync-types";

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
 * Native delivery uses the authenticated account context.
 */
export function useWhoopBleSync(context: WhoopUploadContext, whoopDeps: WhoopBleSyncDeps): void {
  useEffect(() => {
    let active = true;
    initBackgroundWhoopBleSync(context, whoopDeps).catch((error: unknown) => {
      captureException(error, {
        source: "whoop-ble-sync-init",
        ...(active ? {} : { retiredLifetime: true }),
      });
      if (!active) return;
      Alert.alert("WHOOP capture stopped", error instanceof Error ? error.message : String(error));
    });

    return () => {
      active = false;
      teardownBackgroundWhoopBleSync();
    };
  }, [context, whoopDeps]);
}
