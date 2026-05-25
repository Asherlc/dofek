import * as Sentry from "@sentry/node";
import type { SyncDatabase } from "../db/index.ts";
import { queryCache } from "../lib/cache.ts";
import { logger } from "../logger.ts";
import type { RefitSensorStore } from "../personalization/refit.ts";
import type { PostSyncJobData } from "./queues.ts";

const maxSensorDirtyKeyBatches = 1000;

/** Minimal Job interface — only the subset processPostSyncJob actually uses. */
export interface PostSyncJob {
  data: PostSyncJobData;
}

/**
 * Process debounced post-sync work.
 * Global maintenance is serialized through a single delayed job, while personalized refits
 * are debounced per user.
 */
export async function processPostSyncJob(
  job: PostSyncJob,
  db: SyncDatabase,
  getSensorStore: () => RefitSensorStore,
  refreshBodyMeasurements: () => Promise<void>,
  processSensorDirtyKeys: () => Promise<number>,
) {
  try {
    let processedDirtyKeys = 0;
    for (let batchIndex = 0; batchIndex < maxSensorDirtyKeyBatches; batchIndex++) {
      const processedBatchDirtyKeys = await processSensorDirtyKeys();
      processedDirtyKeys += processedBatchDirtyKeys;
      if (processedBatchDirtyKeys === 0) {
        logger.info(`[post-sync] Processed ${processedDirtyKeys} ClickHouse sensor dirty keys.`);
        break;
      }
      if (batchIndex === maxSensorDirtyKeyBatches - 1) {
        throw new Error(
          `ClickHouse sensor dirty-key backlog did not drain after ${maxSensorDirtyKeyBatches} batches`,
        );
      }
    }
  } catch (err) {
    logger.error(`[post-sync] Failed to process ClickHouse sensor dirty keys: ${err}`);
    Sentry.captureException(err, { tags: { postSyncStep: "processSensorDirtyKeys" } });
    throw err;
  }

  if (job.data.type === "global-maintenance") {
    logger.info("[post-sync] Running global post-sync maintenance");

    logger.info("[post-sync] Global post-sync maintenance complete");
    return;
  }

  logger.info(`[post-sync] Running post-sync refit for user ${job.data.userId}`);

  try {
    await refreshBodyMeasurements();
    logger.info("[post-sync] Body measurement read model refreshed.");
  } catch (err) {
    logger.error(`[post-sync] Failed to refresh body measurement read model: ${err}`);
    Sentry.captureException(err, { tags: { postSyncStep: "refreshBodyMeasurements" } });
    throw err;
  }

  try {
    const { refitAllParams } = await import("../personalization/refit.ts");
    logger.info("[post-sync] Refitting personalized parameters...");
    const sensorStore = getSensorStore();
    await refitAllParams(db, job.data.userId, sensorStore);
    logger.info("[post-sync] Personalized parameters updated.");
  } catch (err) {
    logger.error(`[post-sync] Failed to refit parameters: ${err}`);
    Sentry.captureException(err, { tags: { postSyncStep: "refitParams" } });
  }

  // Invalidate user-specific cache after personalized parameters are refitted.
  try {
    await queryCache.invalidateByPrefix(`${job.data.userId}:`);
    logger.info(`[post-sync] Cache invalidated for user ${job.data.userId}`);
  } catch (err) {
    logger.error(`[post-sync] Failed to invalidate cache for user ${job.data.userId}: ${err}`);
    Sentry.captureException(err, { tags: { postSyncStep: "invalidateUserCache" } });
  }

  logger.info(`[post-sync] Post-sync refit complete for user ${job.data.userId}`);
}
