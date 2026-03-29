import type { AccelerometerSample } from "../modules/core-motion";

const UPLOAD_BATCH_SIZE = 5000;
const TWELVE_HOURS_SECONDS = 12 * 3600;

/** Abstraction over CoreMotion native module for testability */
export interface CoreMotionAdapter {
  isAccelerometerRecordingAvailable(): boolean;
  queryRecordedData(fromDate: string, toDate: string): Promise<AccelerometerSample[]>;
  getLastSyncTimestamp(): string | null;
  setLastSyncTimestamp(timestamp: string): void;
  startRecording(durationSeconds: number): Promise<boolean>;
  isRecordingActive(): boolean;
}

/** Abstraction over tRPC client for testability */
export interface AccelerometerSyncTrpcClient {
  accelerometerSync: {
    pushAccelerometerSamples: {
      mutate(input: {
        deviceId: string;
        deviceType: string;
        samples: AccelerometerSample[];
      }): Promise<{ inserted: number }>;
    };
  };
}

export interface AccelerometerSyncOptions {
  trpcClient: AccelerometerSyncTrpcClient;
  coreMotion: CoreMotionAdapter;
  deviceId: string;
  deviceType: string;
  onProgress?: (message: string) => void;
}

export interface AccelerometerSyncResult {
  inserted: number;
  recording: boolean;
}

/**
 * Sync recorded accelerometer data from CMSensorRecorder to the server.
 *
 * 1. Queries from lastSyncTimestamp (or 3 days ago) to now
 * 2. Batches samples into 5,000-sample chunks
 * 3. Uploads each batch via tRPC
 * 4. Advances the sync cursor only after all batches succeed
 * 5. Ensures recording is active (restarts if needed)
 */
export async function syncAccelerometerToServer(
  options: AccelerometerSyncOptions,
): Promise<AccelerometerSyncResult> {
  const { trpcClient, coreMotion, deviceId, deviceType, onProgress } = options;

  if (!coreMotion.isAccelerometerRecordingAvailable()) {
    onProgress?.("Accelerometer recording not available on this device");
    return { inserted: 0, recording: false };
  }

  // Determine sync window
  const now = new Date();
  const lastSync = coreMotion.getLastSyncTimestamp();
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const fromDate = lastSync ? new Date(lastSync) : threeDaysAgo;

  // Don't query into the future or if fromDate is after now
  if (fromDate >= now) {
    onProgress?.("Already up to date");
    await ensureRecording(coreMotion, onProgress);
    return { inserted: 0, recording: true };
  }

  onProgress?.(`Querying accelerometer data from ${fromDate.toISOString()}...`);
  const samples = await coreMotion.queryRecordedData(fromDate.toISOString(), now.toISOString());

  if (samples.length === 0) {
    onProgress?.("No new accelerometer samples");
    coreMotion.setLastSyncTimestamp(now.toISOString());
    await ensureRecording(coreMotion, onProgress);
    return { inserted: 0, recording: true };
  }

  onProgress?.(`Uploading ${samples.length} accelerometer samples...`);

  let totalInserted = 0;
  const totalBatches = Math.ceil(samples.length / UPLOAD_BATCH_SIZE);

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const start = batchIndex * UPLOAD_BATCH_SIZE;
    const batch = samples.slice(start, start + UPLOAD_BATCH_SIZE);

    onProgress?.(`Uploading batch ${batchIndex + 1}/${totalBatches} (${batch.length} samples)...`);

    const result = await trpcClient.accelerometerSync.pushAccelerometerSamples.mutate({
      deviceId,
      deviceType,
      samples: batch,
    });

    totalInserted += result.inserted;
  }

  // All batches succeeded — advance the cursor
  coreMotion.setLastSyncTimestamp(now.toISOString());
  onProgress?.(`Synced ${totalInserted} accelerometer samples`);

  await ensureRecording(coreMotion, onProgress);

  return { inserted: totalInserted, recording: true };
}

/**
 * Ensure accelerometer recording is active.
 * If no recording is running (or it's about to expire), start a new 12-hour session.
 */
async function ensureRecording(
  coreMotion: CoreMotionAdapter,
  onProgress?: (message: string) => void,
): Promise<void> {
  if (!coreMotion.isAccelerometerRecordingAvailable()) return;

  // Always start a new recording — CMSensorRecorder handles overlapping
  // calls gracefully (extends the recording window)
  onProgress?.("Starting accelerometer recording (12 hours)...");
  await coreMotion.startRecording(TWELVE_HOURS_SECONDS);
}
