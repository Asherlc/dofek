import { deleteWatchFile, getPendingWatchFileNames, readWatchFile } from "../modules/watch-motion";
import type { InertialMeasurementUnitSyncTrpcClient } from "./inertial-measurement-unit-sync";
import { captureException, logger } from "./telemetry";

const TAG = "watch-file-sync";
const UPLOAD_BATCH_SIZE = 5000;

export interface WatchFileSyncResult {
  totalInserted: number;
  filesProcessed: number;
  filesFailed: number;
}

/**
 * Sync Watch accelerometer data file-by-file.
 *
 * The Watch transfers compressed JSON files via WCSession. Previous code loaded
 * ALL pending files into a single array and uploaded them as a monolith — if any
 * batch failed, no files were acknowledged and data remained stuck forever.
 *
 * This function processes each file independently: parse → upload batches →
 * delete. A failure in one file does not block others.
 */
export async function syncWatchAccelerometerFiles(
  trpcClient: InertialMeasurementUnitSyncTrpcClient,
): Promise<WatchFileSyncResult> {
  const fileNames = getPendingWatchFileNames();

  logger.info(TAG, `Found ${fileNames.length} pending files`);

  if (fileNames.length === 0) {
    return { totalInserted: 0, filesProcessed: 0, filesFailed: 0 };
  }

  let totalInserted = 0;
  let filesProcessed = 0;
  let filesFailed = 0;

  for (const fileName of fileNames) {
    try {
      logger.info(TAG, `Reading ${fileName}`);
      const samples = await readWatchFile(fileName);
      logger.info(TAG, `${fileName}: ${samples.length} samples`);

      if (samples.length === 0) {
        deleteWatchFile(fileName);
        filesProcessed++;
        continue;
      }

      // Upload in batches
      const totalBatches = Math.ceil(samples.length / UPLOAD_BATCH_SIZE);
      for (let offset = 0; offset < samples.length; offset += UPLOAD_BATCH_SIZE) {
        const batchIndex = Math.floor(offset / UPLOAD_BATCH_SIZE) + 1;
        const batch = samples.slice(offset, offset + UPLOAD_BATCH_SIZE);
        logger.info(
          TAG,
          `${fileName}: uploading batch ${batchIndex}/${totalBatches} (${batch.length} samples)`,
        );
        const result = await trpcClient.inertialMeasurementUnitSync.pushSamples.mutate({
          deviceId: "Apple Watch",
          deviceType: "apple_watch",
          samples: batch,
        });
        totalInserted += result.inserted;
      }

      // All batches for this file succeeded — safe to delete
      deleteWatchFile(fileName);
      filesProcessed++;
      logger.info(TAG, `${fileName}: done, deleted`);
    } catch (error) {
      filesFailed++;
      const message = error instanceof Error ? error.message : String(error);
      logger.error(TAG, `${fileName} FAILED: ${message}`);
      captureException(error instanceof Error ? error : new Error(String(error)), {
        source: "watch-file-sync",
        extra: { fileName },
      });
    }
  }

  logger.info(
    TAG,
    `Complete: ${filesProcessed} processed, ${filesFailed} failed, ${totalInserted} samples inserted`,
  );
  return { totalInserted, filesProcessed, filesFailed };
}
