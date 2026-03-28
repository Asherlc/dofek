import { deleteWatchFile, getPendingWatchFileNames, readWatchFile } from "../modules/watch-motion";
import type { AccelerometerSyncTrpcClient } from "./accelerometer-sync";
import { captureException } from "./telemetry";

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
  trpcClient: AccelerometerSyncTrpcClient,
): Promise<WatchFileSyncResult> {
  const fileNames = getPendingWatchFileNames();

  if (fileNames.length === 0) {
    return { totalInserted: 0, filesProcessed: 0, filesFailed: 0 };
  }

  let totalInserted = 0;
  let filesProcessed = 0;
  let filesFailed = 0;

  for (const fileName of fileNames) {
    try {
      const samples = await readWatchFile(fileName);

      if (samples.length === 0) {
        deleteWatchFile(fileName);
        filesProcessed++;
        continue;
      }

      // Upload in batches
      for (let offset = 0; offset < samples.length; offset += UPLOAD_BATCH_SIZE) {
        const batch = samples.slice(offset, offset + UPLOAD_BATCH_SIZE);
        const result = await trpcClient.accelerometerSync.pushAccelerometerSamples.mutate({
          deviceId: "Apple Watch",
          deviceType: "apple_watch",
          samples: batch,
        });
        totalInserted += result.inserted;
      }

      // All batches for this file succeeded — safe to delete
      deleteWatchFile(fileName);
      filesProcessed++;
    } catch (error) {
      filesFailed++;
      captureException(error instanceof Error ? error : new Error(String(error)), {
        source: "watch-file-sync",
        extra: { fileName },
      });
    }
  }

  return { totalInserted, filesProcessed, filesFailed };
}
