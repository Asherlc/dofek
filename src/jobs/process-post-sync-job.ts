import * as telemetry from "dofek/telemetry";
import type { SyncDatabase } from "../db/index.ts";
import { logger } from "../logger.ts";
import type { PostSyncJobData } from "./queues.ts";

/** Minimal Job interface — only the subset processPostSyncJob actually uses. */
export interface PostSyncJob {
  data: PostSyncJobData;
}

/**
 * Process debounced post-sync work: materialized view refresh, parameter refit, etc.
 * This runs once per user after all their provider syncs settle (debounced in the queue).
 */
export async function processPostSyncJob(job: PostSyncJob, db: SyncDatabase) {
  const { userId } = job.data;
  logger.info(`[post-sync] Running post-sync work for user ${userId}`);

  // Refresh materialized views first — updateUserMaxHr reads from activity_summary
  try {
    const { refreshDedupViews } = await import("../db/dedup.ts");
    await refreshDedupViews(db);
  } catch (err) {
    logger.error(`[post-sync] Failed to refresh views: ${err}`);
    telemetry.captureException(err, { tags: { postSyncStep: "refreshDedupViews" } });
  }

  try {
    const { updateUserMaxHr } = await import("../db/dedup.ts");
    await updateUserMaxHr(db);
  } catch (err) {
    logger.error(`[post-sync] Failed to update max HR: ${err}`);
    telemetry.captureException(err, { tags: { postSyncStep: "updateMaxHr" } });
  }

  try {
    const { loadProviderPriorityConfig, syncProviderPriorities } = await import(
      "../db/provider-priority.ts"
    );
    const config = loadProviderPriorityConfig();
    if (config) {
      await syncProviderPriorities(db, config);
    }
  } catch (err) {
    logger.error(`[post-sync] Failed to sync provider priorities: ${err}`);
    telemetry.captureException(err, { tags: { postSyncStep: "syncProviderPriorities" } });
  }

  try {
    const { refitAllParams } = await import("../personalization/refit.ts");
    logger.info("[post-sync] Refitting personalized parameters...");
    await refitAllParams(db, userId);
    logger.info("[post-sync] Personalized parameters updated.");
  } catch (err) {
    logger.error(`[post-sync] Failed to refit parameters: ${err}`);
    telemetry.captureException(err, { tags: { postSyncStep: "refitParams" } });
  }

  logger.info(`[post-sync] Post-sync work complete for user ${userId}`);
}
