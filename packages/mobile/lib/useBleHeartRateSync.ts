import { useEffect } from "react";
import {
  type BleHeartRateSyncDeps,
  type BleHeartRateUploadClient,
  initBackgroundBleHeartRateSync,
  teardownBackgroundBleHeartRateSync,
} from "./background-ble-heart-rate-sync";
import { captureException } from "./telemetry";

/** Own the standard BLE heart-rate lifecycle for an authenticated app session. */
export function useBleHeartRateSync(
  uploadClient: BleHeartRateUploadClient,
  deps: BleHeartRateSyncDeps,
): void {
  useEffect(() => {
    void initBackgroundBleHeartRateSync(uploadClient, deps).catch((error: unknown) => {
      captureException(error, { source: "ble-heart-rate-sync-init" });
    });

    return () => {
      void teardownBackgroundBleHeartRateSync().catch((error: unknown) => {
        captureException(error, { source: "ble-heart-rate-sync-teardown" });
      });
    };
  }, [uploadClient, deps]);
}
