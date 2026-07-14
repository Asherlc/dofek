import * as Sentry from "@sentry/node";
import type { SyncDatabase } from "../db/index.ts";
import { queryCache } from "../lib/cache.ts";
import { logger } from "../logger.ts";
import type { RefitSensorStore } from "../personalization/refit.ts";
import { reportJobProgress } from "./job-progress.ts";
import type { PostSyncJobData } from "./queues.ts";

/** Minimal Job interface — only the subset processPostSyncJob actually uses. */
export interface PostSyncJob {
  data: PostSyncJobData;
  updateProgress: (data: { percentage: number; message: string }) => Promise<void>;
}

async function updatePostSyncProgress(
  job: PostSyncJob,
  percentage: number,
  message: string,
): Promise<void> {
  await reportJobProgress(
    job,
    percentage,
    message,
    "Failed to update post-sync progress: %s",
    "postSyncStep",
  );
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
) {
  if (job.data.type === "global-maintenance") {
    await updatePostSyncProgress(job, 0, "Starting global post-sync maintenance...");
    logger.info("[post-sync] Running global post-sync maintenance");

    logger.info("[post-sync] Global post-sync maintenance complete");
    await updatePostSyncProgress(job, 100, "Global post-sync maintenance complete.");
    return;
  }

  await updatePostSyncProgress(job, 0, "Starting post-sync refit...");
  logger.info(`[post-sync] Running post-sync refit for user ${job.data.userId}`);
  let completedWithErrors = false;

  try {
    await updatePostSyncProgress(job, 20, "Refreshing body measurements...");
    await refreshBodyMeasurements();
    logger.info("[post-sync] Body measurement read model refreshed.");
  } catch (err) {
    logger.error(`[post-sync] Failed to refresh body measurement read model: ${err}`);
    Sentry.captureException(err, { tags: { postSyncStep: "refreshBodyMeasurements" } });
    throw err;
  }

  try {
    const { refitAllParams } = await import("../personalization/refit.ts");
    await updatePostSyncProgress(job, 45, "Refitting personalized parameters...");
    logger.info("[post-sync] Refitting personalized parameters...");
    const sensorStore = getSensorStore();
    await refitAllParams(db, job.data.userId, sensorStore);
    logger.info("[post-sync] Personalized parameters updated.");
  } catch (err) {
    completedWithErrors = true;
    logger.error(`[post-sync] Failed to refit parameters: ${err}`);
    Sentry.captureException(err, { tags: { postSyncStep: "refitParams" } });
  }

  // Invalidate user-specific cache after personalized parameters are refitted.
  try {
    await updatePostSyncProgress(job, 75, "Invalidating user cache...");
    await queryCache.invalidateByPrefix(`${job.data.userId}:`);
    logger.info(`[post-sync] Cache invalidated for user ${job.data.userId}`);
  } catch (err) {
    completedWithErrors = true;
    logger.error(`[post-sync] Failed to invalidate cache for user ${job.data.userId}: ${err}`);
    Sentry.captureException(err, { tags: { postSyncStep: "invalidateUserCache" } });
  }

  logger.info(`[post-sync] Post-sync refit complete for user ${job.data.userId}`);
  await updatePostSyncProgress(
    job,
    100,
    completedWithErrors ? "Post-sync refit completed with errors." : "Post-sync refit complete.",
  );
}
