import * as Sentry from "@sentry/node";
import {
  runActivityReadModelBuild,
  waitForPeerDbActivityDeletes,
  waitForPeerDbActivityRestores,
} from "../analytics/activity-read-model-build.ts";
import { createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { queryCache } from "../lib/cache.ts";
import { logger } from "../logger.ts";
import type { ActivityAnalyticsJobData } from "./queues.ts";

export interface ActivityAnalyticsJob {
  data: ActivityAnalyticsJobData;
  updateProgress: (data: { percentage: number; message: string }) => Promise<void>;
}

async function updateActivityAnalyticsProgress(
  job: ActivityAnalyticsJob,
  percentage: number,
  message: string,
): Promise<void> {
  await job.updateProgress({ percentage, message }).catch((error: unknown) => {
    logger.warn("Failed to update activity analytics progress: %s", error);
    Sentry.captureException(error, { tags: { activityAnalyticsStep: "updateProgress" } });
  });
}

async function rebuildActivityAnalytics(
  job: ActivityAnalyticsJob,
  userId: string,
  logMessage: string,
): Promise<void> {
  await updateActivityAnalyticsProgress(job, 60, "Rebuilding activity analytics...");
  await runActivityReadModelBuild();
  await updateActivityAnalyticsProgress(job, 90, "Invalidating activity analytics cache...");
  await queryCache.invalidateByPrefix(`${userId}:`);
  logger.info(logMessage);
  await updateActivityAnalyticsProgress(job, 100, "Activity analytics refresh complete.");
}

export async function processActivityDeleteAnalyticsJob(job: ActivityAnalyticsJob): Promise<void> {
  const { userId, activityIds } = job.data;
  const client = createClickHouseClientFromEnv();

  try {
    await updateActivityAnalyticsProgress(job, 0, "Starting activity analytics refresh...");
    if (job.data.type === "activity-recompute-analytics-refresh") {
      await rebuildActivityAnalytics(
        job,
        userId,
        `[activity-recompute-analytics] Refreshed activity read models for ${activityIds.length} activities for user ${userId}`,
      );
      return;
    }

    if (job.data.type === "activity-restore-analytics-refresh") {
      await updateActivityAnalyticsProgress(
        job,
        20,
        "Waiting for activity restores to reach analytics...",
      );
      await waitForPeerDbActivityRestores(client, activityIds);
      await rebuildActivityAnalytics(
        job,
        userId,
        `[activity-restore-analytics] Refreshed activity read models after restoring ${activityIds.length} activities for user ${userId}`,
      );
      return;
    }

    await updateActivityAnalyticsProgress(
      job,
      20,
      "Waiting for activity deletes to reach analytics...",
    );
    await waitForPeerDbActivityDeletes(client, activityIds);
    await rebuildActivityAnalytics(
      job,
      userId,
      `[activity-delete-analytics] Refreshed activity read models after deleting ${activityIds.length} activities for user ${userId}`,
    );
  } finally {
    await client.close?.();
  }
}
