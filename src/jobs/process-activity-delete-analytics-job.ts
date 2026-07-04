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
}

export async function processActivityDeleteAnalyticsJob(job: ActivityAnalyticsJob): Promise<void> {
  const { userId, activityIds } = job.data;
  const client = createClickHouseClientFromEnv();

  try {
    if (job.data.type === "activity-recompute-analytics-refresh") {
      await runActivityReadModelBuild();
      await queryCache.invalidateByPrefix(`${userId}:`);
      logger.info(
        `[activity-recompute-analytics] Refreshed activity read models for ${activityIds.length} activities for user ${userId}`,
      );
      return;
    }

    if (job.data.type === "activity-restore-analytics-refresh") {
      await waitForPeerDbActivityRestores(client, activityIds);
      await runActivityReadModelBuild();
      await queryCache.invalidateByPrefix(`${userId}:`);
      logger.info(
        `[activity-restore-analytics] Refreshed activity read models after restoring ${activityIds.length} activities for user ${userId}`,
      );
      return;
    }

    await waitForPeerDbActivityDeletes(client, activityIds);
    await runActivityReadModelBuild();
    await queryCache.invalidateByPrefix(`${userId}:`);
    logger.info(
      `[activity-delete-analytics] Refreshed activity read models after deleting ${activityIds.length} activities for user ${userId}`,
    );
  } finally {
    await client.close?.();
  }
}
