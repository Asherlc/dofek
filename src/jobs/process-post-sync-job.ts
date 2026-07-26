import * as Sentry from "@sentry/node";
import type { SyncDatabase } from "../db/index.ts";
import { invalidateAllUserQueries } from "../lib/cache.ts";
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

  try {
    await updatePostSyncProgress(job, 20, "Refreshing body measurements...");
    await refreshBodyMeasurements();
    logger.info("[post-sync] Body measurement read model refreshed.");
  } catch (error) {
    logger.error(`[post-sync] Failed to refresh body measurement read model: ${error}`);
    Sentry.captureException(error, {
      tags: { postSyncStep: "refreshBodyMeasurements" },
    });
    await updatePostSyncProgress(job, 20, "Body measurement refresh failed; retry required.");
    throw error;
  }

  try {
    const { refitAllParams } = await import("../personalization/refit.ts");
    await updatePostSyncProgress(job, 45, "Refitting personalized parameters...");
    logger.info("[post-sync] Refitting personalized parameters...");
    const sensorStore = getSensorStore();
    await refitAllParams(db, job.data.userId, sensorStore);
    logger.info("[post-sync] Personalized parameters updated.");
  } catch (error) {
    logger.error(`[post-sync] Failed to refit parameters: ${error}`);
    Sentry.captureException(error, { tags: { postSyncStep: "refitParams" } });
    await updatePostSyncProgress(job, 45, "Personalized parameter refit failed; retry required.");
    throw error;
  }

  // Invalidate user-specific cache after personalized parameters are refitted.
  try {
    await updatePostSyncProgress(job, 75, "Invalidating user cache...");
    await invalidateAllUserQueries(job.data.userId);
    logger.info(`[post-sync] Cache invalidated for user ${job.data.userId}`);
  } catch (error) {
    logger.error(`[post-sync] Failed to invalidate cache for user ${job.data.userId}: ${error}`);
    Sentry.captureException(error, {
      tags: { postSyncStep: "invalidateUserCache" },
    });
    await updatePostSyncProgress(job, 75, "User cache invalidation failed; retry required.");
    throw error;
  }

  logger.info(`[post-sync] Post-sync refit complete for user ${job.data.userId}`);
  await updatePostSyncProgress(job, 100, "Post-sync refit complete.");
}
