import { deleteWatchFile, getPendingWatchAltitudeFileNames, readWatchAltitudeFile } from "../modules/watch-motion";
import { captureException, logger } from "./telemetry";

const TAG = "watch-altitude-file-sync";
const UPLOAD_BATCH_SIZE = 2000;

export interface WatchAltitudeSyncTrpcClient {
  watchAltitudeSync: {
    pushSamples: {
      mutate(input: {
        deviceId: string;
        samples: Array<{
          timestamp: string;
          altitudeM: number;
          pressureKPa?: number;
        }>;
      }): Promise<{ inserted: number }>;
    };
  };
}

export interface WatchAltitudeFileSyncResult {
  totalInserted: number;
  filesProcessed: number;
  filesFailed: number;
}

function parseAltitudeSample(raw: Record<string, unknown>) {
  const timestamp = raw.timestamp;
  const altitudeM = raw.altitudeM;
  if (typeof timestamp !== "string" || typeof altitudeM !== "number") {
    return null;
  }

  const pressureKPa = raw.pressureKPa;
  return {
    timestamp,
    altitudeM,
    pressureKPa: typeof pressureKPa === "number" ? pressureKPa : undefined,
  };
}

/**
 * Sync Watch barometric altitude data file-by-file.
 */
export async function syncWatchAltitudeFiles(
  trpcClient: WatchAltitudeSyncTrpcClient,
): Promise<WatchAltitudeFileSyncResult> {
  const fileNames = getPendingWatchAltitudeFileNames();

  logger.info(TAG, `Found ${fileNames.length} pending altitude files`);

  if (fileNames.length === 0) {
    return { totalInserted: 0, filesProcessed: 0, filesFailed: 0 };
  }

  let totalInserted = 0;
  let filesProcessed = 0;
  let filesFailed = 0;

  for (const fileName of fileNames) {
    try {
      logger.info(TAG, `Reading ${fileName}`);
      const rawSamples = await readWatchAltitudeFile(fileName);
      const samples = rawSamples
        .map((sample) => parseAltitudeSample(sample as Record<string, unknown>))
        .filter((sample): sample is NonNullable<typeof sample> => sample != null);

      logger.info(TAG, `${fileName}: ${samples.length} samples`);

      if (samples.length === 0) {
        deleteWatchFile(fileName);
        filesProcessed++;
        continue;
      }

      const totalBatches = Math.ceil(samples.length / UPLOAD_BATCH_SIZE);
      for (let offset = 0; offset < samples.length; offset += UPLOAD_BATCH_SIZE) {
        const batchIndex = Math.floor(offset / UPLOAD_BATCH_SIZE) + 1;
        const batch = samples.slice(offset, offset + UPLOAD_BATCH_SIZE);
        logger.info(
          TAG,
          `${fileName}: uploading batch ${batchIndex}/${totalBatches} (${batch.length} samples)`,
        );
        const result = await trpcClient.watchAltitudeSync.pushSamples.mutate({
          deviceId: "Apple Watch",
          samples: batch,
        });
        totalInserted += result.inserted;
      }

      deleteWatchFile(fileName);
      filesProcessed++;
      logger.info(TAG, `${fileName}: done, deleted`);
    } catch (error) {
      filesFailed++;
      const message = error instanceof Error ? error.message : String(error);
      logger.error(TAG, `${fileName} FAILED: ${message}`);
      captureException(error instanceof Error ? error : new Error(String(error)), {
        source: "watch-altitude-file-sync",
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
