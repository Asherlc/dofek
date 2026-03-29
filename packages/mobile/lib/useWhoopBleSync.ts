import * as Sentry from "@sentry/react-native";
import { useEffect } from "react";
import {
  initBackgroundWhoopBleSync,
  teardownBackgroundWhoopBleSync,
  type WhoopBleSyncDeps,
} from "./background-whoop-ble-sync";
import type { InertialMeasurementUnitUploadClient } from "./inertial-measurement-unit-service";
import { trpc } from "./trpc";

/**
 * Hook that reactively starts/stops WHOOP BLE accelerometer sync
 * based on the `whoopAlwaysOnImu` user setting.
 *
 * When the setting is enabled, connects to the WHOOP strap and begins
 * streaming IMU data. When disabled, tears down the connection.
 *
 * Must be rendered inside a tRPC provider.
 */
export function useWhoopBleSync(
  uploadClient: InertialMeasurementUnitUploadClient,
  whoopDeps: WhoopBleSyncDeps,
): void {
  const whoopImuSetting = trpc.settings.get.useQuery({ key: "whoopAlwaysOnImu" });
  const enabled = whoopImuSetting.data?.value === true;

  useEffect(() => {
    if (!enabled) {
      teardownBackgroundWhoopBleSync();
      return;
    }

    initBackgroundWhoopBleSync(uploadClient, whoopDeps).catch((error: unknown) => {
      Sentry.captureException(error, { tags: { source: "whoop-ble-sync-init" } });
    });

    return () => {
      teardownBackgroundWhoopBleSync();
    };
  }, [enabled, uploadClient, whoopDeps]);
}
