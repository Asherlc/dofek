import type { InertialMeasurementUnitSample } from "@dofek/imu";
import type { WhoopRealtimeDataSample } from "../modules/whoop-ble";
import { isAfterDeviceErasureCutoff } from "./device-erasure-cutoff";
import { DeviceSampleGroups, type DeviceScopedSample } from "./device-sample-groups";
import { captureException, logger } from "./telemetry";
import type {
  WhoopBleDiagnostics,
  WhoopSyncTrigger,
  WhoopUploadBatch,
} from "./whoop-ble-diagnostics";
import type {
  InertialMeasurementUnitUploadClient,
  WhoopBleRealtimeUploadClient,
  WhoopBleSyncDeps,
} from "./whoop-ble-sync-types";

const LOG_CATEGORY = "whoop-ble";
const IMU_UPLOAD_BATCH_SIZE = 500;
const REALTIME_UPLOAD_BATCH_SIZE = 500;
const DEFAULT_WHOOP_DEVICE_ID = "WHOOP Strap";
type BufferedInertialMeasurementUnitSample = InertialMeasurementUnitSample & DeviceScopedSample;
type ShouldContinueUploading = () => boolean;
type RealtimeDataSample = WhoopRealtimeDataSample;

function toInertialMeasurementUnitUploadSample(
  sample: BufferedInertialMeasurementUnitSample,
): InertialMeasurementUnitSample {
  return {
    timestamp: sample.timestamp,
    x: sample.x,
    y: sample.y,
    z: sample.z,
    gyroscopeX: sample.gyroscopeX,
    gyroscopeY: sample.gyroscopeY,
    gyroscopeZ: sample.gyroscopeZ,
  };
}

function toRealtimeDataUploadSample(
  sample: RealtimeDataSample,
): Omit<RealtimeDataSample, "deviceId"> {
  return {
    timestamp: sample.timestamp,
    heartRateBpm: sample.heartRateBpm,
    rrIntervalMs: sample.rrIntervalMs,
    quaternionW: sample.quaternionW,
    quaternionX: sample.quaternionX,
    quaternionY: sample.quaternionY,
    quaternionZ: sample.quaternionZ,
    opticalRawHex: sample.opticalRawHex,
  };
}

export async function drainWhoopImuBuffer(
  trpcClient: InertialMeasurementUnitUploadClient,
  whoopDeps: WhoopBleSyncDeps,
  deviceErasureCutoff: string | null,
  shouldContinueUploading: ShouldContinueUploading,
  trigger: WhoopSyncTrigger,
  diagnostics: WhoopBleDiagnostics,
  isActive: () => boolean,
): Promise<void> {
  // Drain IMU buffer using peek-then-confirm: samples stay in the native
  // buffer until the server confirms receipt, preventing data loss on
  // network failures.
  let totalImuUploaded = 0;
  while (isActive()) {
    const samples = await whoopDeps.peekBufferedSamples(IMU_UPLOAD_BATCH_SIZE);
    if (!isActive() || samples.length === 0) break;
    const uploadableSamples =
      deviceErasureCutoff === null
        ? samples
        : samples.filter((sample) =>
            isAfterDeviceErasureCutoff(sample.timestamp, deviceErasureCutoff),
          );

    let deviceIds = Array.from(
      new Set(
        uploadableSamples.map((sample) => sample.deviceId?.trim() || DEFAULT_WHOOP_DEVICE_ID),
      ),
    );
    let firstTimestamp: string | undefined;
    let lastTimestamp: string | undefined;
    const batches: WhoopUploadBatch[] = [];
    let pendingBatch: WhoopUploadBatch | undefined;

    try {
      const groups = new DeviceSampleGroups(
        DEFAULT_WHOOP_DEVICE_ID,
        toInertialMeasurementUnitUploadSample,
      );
      for (const sample of uploadableSamples) {
        groups.add(sample);
      }
      deviceIds = [...groups.entries()].map(([deviceId]) => deviceId);
      firstTimestamp = samples[0]?.timestamp;
      lastTimestamp = samples[samples.length - 1]?.timestamp;

      let inserted = 0;
      for (const [deviceId, uploadSamples] of groups.entries()) {
        if (!isActive()) return;
        if (!shouldContinueUploading()) {
          diagnostics.skipped("imu", "app_inactive", trigger);
          logger.info(LOG_CATEGORY, "IMU upload skipped — app is no longer active");
          return;
        }
        pendingBatch = diagnostics.uploadStarted("imu", deviceId, uploadSamples);
        const result = await trpcClient.inertialMeasurementUnitSync.pushSamples.mutate({
          deviceId,
          deviceType: "whoop",
          samples: uploadSamples,
          telemetry: pendingBatch.telemetry,
        });
        if (!isActive()) return;
        diagnostics.uploadAcknowledged(pendingBatch, result.inserted);
        batches.push(pendingBatch);
        pendingBatch = undefined;
        inserted += result.inserted;
      }
      whoopDeps.confirmSamplesDrain(samples.length);
      diagnostics.bufferConfirmed(
        "imu",
        batches,
        samples.length,
        samples.length - uploadableSamples.length,
      );
      totalImuUploaded += samples.length;
      logger.info(
        LOG_CATEGORY,
        `uploaded ${samples.length} IMU samples (server inserted: ${inserted})`,
      );
    } catch (error: unknown) {
      if (!isActive()) {
        captureException(error, { source: "whoop-ble-retired-upload", retiredLifetime: true });
        return;
      }
      if (pendingBatch) diagnostics.uploadFailed(pendingBatch, error);
      logger.error(LOG_CATEGORY, `IMU upload failed, ${samples.length} samples retained: ${error}`);
      captureException(error, {
        source: "whoop-ble-imu-upload",
        ...pendingBatch?.telemetry,
        bufferedSampleCount: samples.length,
        deviceCount: deviceIds.length,
        deviceIds,
        firstTimestamp: firstTimestamp ?? samples[0]?.timestamp,
        lastTimestamp: lastTimestamp ?? samples[samples.length - 1]?.timestamp,
      });
      break; // Stop draining — samples are still in the buffer for retry
    }
  }

  if (isActive() && totalImuUploaded > 0) {
    logger.info(LOG_CATEGORY, `IMU drain complete: ${totalImuUploaded} samples`);
  }
}

export async function drainWhoopRealtimeBuffer(
  realtimeClient: WhoopBleRealtimeUploadClient,
  whoopDeps: WhoopBleSyncDeps,
  deviceErasureCutoff: string | null,
  shouldContinueUploading: ShouldContinueUploading,
  trigger: WhoopSyncTrigger,
  diagnostics: WhoopBleDiagnostics,
  isActive: () => boolean,
): Promise<void> {
  // Drain realtime data buffer (beat interval + quaternion + optical from 0x28 packets)
  let totalRealtimeUploaded = 0;
  while (isActive()) {
    const realtimeSamples = await whoopDeps.peekBufferedRealtimeData(REALTIME_UPLOAD_BATCH_SIZE);
    if (!isActive()) return;
    logger.info(LOG_CATEGORY, `realtime buffer: ${realtimeSamples.length} samples`);
    if (realtimeSamples.length === 0) break;
    const uploadableRealtimeSamples =
      deviceErasureCutoff === null
        ? realtimeSamples
        : realtimeSamples.filter((sample) =>
            isAfterDeviceErasureCutoff(sample.timestamp, deviceErasureCutoff),
          );

    const batches: WhoopUploadBatch[] = [];
    let pendingBatch: WhoopUploadBatch | undefined;

    try {
      const groups = new DeviceSampleGroups(DEFAULT_WHOOP_DEVICE_ID, toRealtimeDataUploadSample);
      for (const sample of uploadableRealtimeSamples) {
        groups.add(sample);
      }

      let inserted = 0;
      for (const [deviceId, uploadSamples] of groups.entries()) {
        if (!isActive()) return;
        if (!shouldContinueUploading()) {
          diagnostics.skipped("realtime", "app_inactive", trigger);
          logger.info(LOG_CATEGORY, "realtime upload skipped — app is no longer active");
          return;
        }
        pendingBatch = diagnostics.uploadStarted("realtime", deviceId, uploadSamples);
        const result = await realtimeClient.whoopBleSync.pushRealtimeData.mutate({
          deviceId,
          samples: uploadSamples,
          telemetry: pendingBatch.telemetry,
        });
        if (!isActive()) return;
        diagnostics.uploadAcknowledged(pendingBatch, result.inserted);
        batches.push(pendingBatch);
        pendingBatch = undefined;
        inserted += result.inserted;
      }
      whoopDeps.confirmRealtimeDataDrain(realtimeSamples.length);
      diagnostics.bufferConfirmed(
        "realtime",
        batches,
        realtimeSamples.length,
        realtimeSamples.length - uploadableRealtimeSamples.length,
      );
      totalRealtimeUploaded += realtimeSamples.length;
      logger.info(
        LOG_CATEGORY,
        `uploaded ${realtimeSamples.length} realtime samples (server inserted: ${inserted})`,
      );
    } catch (error: unknown) {
      if (!isActive()) {
        captureException(error, { source: "whoop-ble-retired-upload", retiredLifetime: true });
        return;
      }
      if (pendingBatch) diagnostics.uploadFailed(pendingBatch, error);
      logger.error(
        LOG_CATEGORY,
        `realtime upload failed, ${realtimeSamples.length} samples retained: ${error}`,
      );
      captureException(error, { source: "whoop-ble-realtime-upload", ...pendingBatch?.telemetry });
      break;
    }
  }

  if (isActive() && totalRealtimeUploaded > 0) {
    logger.info(LOG_CATEGORY, `realtime drain complete: ${totalRealtimeUploaded} samples`);
  }
}
