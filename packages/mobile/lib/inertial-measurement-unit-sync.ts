import type { InertialMeasurementUnitSample } from "@dofek/imu";
import { isAfterDeviceErasureCutoff } from "./device-erasure-cutoff";

const UPLOAD_BATCH_SIZE = 5000;
const TWELVE_HOURS_SECONDS = 12 * 3600;
const SENSOR_QUERY_WINDOW_MS = 10 * 60 * 1000;
const SENSOR_HISTORY_LOOKBACK_MS = 2.9 * 24 * 60 * 60 * 1000;

/** Abstraction over CoreMotion native module for testability */
export interface InertialMeasurementUnitAdapter {
  isAccelerometerRecordingAvailable(): boolean;
  queryRecordedData(fromDate: string, toDate: string): Promise<InertialMeasurementUnitSample[]>;
  getLastSyncTimestamp(): string | null;
  setLastSyncTimestamp(timestamp: string): void;
  startRecording(durationSeconds: number): Promise<boolean>;
  isRecordingActive(): boolean;
}

/** Abstraction over tRPC client for testability */
export interface InertialMeasurementUnitSyncTrpcClient {
  inertialMeasurementUnitSync: {
    pushSamples: {
      mutate(input: {
        deviceId: string;
        deviceType: string;
        samples: InertialMeasurementUnitSample[];
      }): Promise<{ inserted: number }>;
    };
  };
}

export interface InertialMeasurementUnitSyncOptions {
  trpcClient: InertialMeasurementUnitSyncTrpcClient;
  coreMotion: InertialMeasurementUnitAdapter;
  deviceId: string;
  deviceType: string;
  minimumSampleDate?: string | null;
  onProgress?: (message: string) => void;
}

export interface InertialMeasurementUnitSyncResult {
  inserted: number;
  recording: boolean;
}

/**
 * Sync recorded IMU data from CMSensorRecorder to the server.
 *
 * 1. Queries from lastSyncTimestamp (or 3 days ago) in bounded windows
 * 2. Batches samples into 5,000-sample chunks
 * 3. Uploads each batch via tRPC
 * 4. Advances the sync cursor only after all batches succeed
 * 5. Ensures recording is active (restarts if needed)
 */
export async function syncInertialMeasurementUnitToServer(
  options: InertialMeasurementUnitSyncOptions,
): Promise<InertialMeasurementUnitSyncResult> {
  const {
    trpcClient,
    coreMotion,
    deviceId,
    deviceType,
    minimumSampleDate = null,
    onProgress,
  } = options;

  if (!coreMotion.isAccelerometerRecordingAvailable()) {
    onProgress?.("Accelerometer recording not available on this device");
    return { inserted: 0, recording: false };
  }

  // Determine sync window
  const now = new Date();
  const lastSync = coreMotion.getLastSyncTimestamp();
  const oldestQueryableDate = new Date(now.getTime() - SENSOR_HISTORY_LOOKBACK_MS);
  const requestedFromDate = lastSync ? new Date(lastSync) : oldestQueryableDate;
  let fromDate = requestedFromDate < oldestQueryableDate ? oldestQueryableDate : requestedFromDate;
  if (minimumSampleDate !== null) {
    const cutoffDate = new Date(minimumSampleDate);
    if (!Number.isFinite(cutoffDate.getTime())) {
      throw new Error("Device erasure cutoff is invalid.");
    }
    if (cutoffDate > fromDate) {
      fromDate = cutoffDate;
    }
  }
  const queryWindowEndDate = new Date(
    Math.min(fromDate.getTime() + SENSOR_QUERY_WINDOW_MS, now.getTime()),
  );

  // Don't query into the future or if fromDate is after now
  if (fromDate >= now) {
    onProgress?.("Already up to date");
    await ensureRecording(coreMotion, onProgress);
    return { inserted: 0, recording: true };
  }

  onProgress?.(`Querying IMU data from ${fromDate.toISOString()}...`);
  const samples = (
    await coreMotion.queryRecordedData(fromDate.toISOString(), queryWindowEndDate.toISOString())
  ).filter(
    (sample) =>
      minimumSampleDate === null || isAfterDeviceErasureCutoff(sample.timestamp, minimumSampleDate),
  );

  if (samples.length === 0) {
    onProgress?.("No new IMU samples");
    coreMotion.setLastSyncTimestamp(queryWindowEndDate.toISOString());
    await ensureRecording(coreMotion, onProgress);
    return { inserted: 0, recording: true };
  }

  onProgress?.(`Uploading ${samples.length} IMU samples...`);

  let totalInserted = 0;
  const totalBatches = Math.ceil(samples.length / UPLOAD_BATCH_SIZE);

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const start = batchIndex * UPLOAD_BATCH_SIZE;
    const batch = samples.slice(start, start + UPLOAD_BATCH_SIZE);

    onProgress?.(`Uploading batch ${batchIndex + 1}/${totalBatches} (${batch.length} samples)...`);

    const result = await trpcClient.inertialMeasurementUnitSync.pushSamples.mutate({
      deviceId,
      deviceType,
      samples: batch,
    });

    totalInserted += result.inserted;
  }

  // All batches succeeded — advance the cursor
  coreMotion.setLastSyncTimestamp(queryWindowEndDate.toISOString());
  onProgress?.(`Synced ${totalInserted} IMU samples`);

  await ensureRecording(coreMotion, onProgress);

  return { inserted: totalInserted, recording: true };
}

/**
 * Ensure accelerometer recording is active.
 * If no recording is running (or it's about to expire), start a new 12-hour session.
 */
async function ensureRecording(
  coreMotion: InertialMeasurementUnitAdapter,
  onProgress?: (message: string) => void,
): Promise<void> {
  if (!coreMotion.isAccelerometerRecordingAvailable()) return;

  // Always start a new recording — CMSensorRecorder handles overlapping
  // calls gracefully (extends the recording window)
  onProgress?.("Starting accelerometer recording (12 hours)...");
  await coreMotion.startRecording(TWELVE_HOURS_SECONDS);
}
