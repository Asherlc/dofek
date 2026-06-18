import * as Sentry from "@sentry/node";
import {
  runActivityReadModelBuild,
  waitForPeerDbActivityDeletes,
} from "../analytics/activity-read-model-build.ts";
import { createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { queryCache } from "../lib/cache.ts";
import { logger } from "../logger.ts";
import type { ActivityDeleteAnalyticsJobData } from "./queues.ts";

export interface ActivityDeleteAnalyticsJob {
  data: ActivityDeleteAnalyticsJobData;
}

export async function processActivityDeleteAnalyticsJob(
  job: ActivityDeleteAnalyticsJob,
): Promise<void> {
  const { userId, activityIds } = job.data;
  const client = createClickHouseClientFromEnv();

  try {
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

export async function processActivityDeleteAnalyticsJobSafe(
  job: ActivityDeleteAnalyticsJob,
): Promise<void> {
  try {
    await processActivityDeleteAnalyticsJob(job);
  } catch (error) {
    Sentry.captureException(error, {
      tags: { job: "activity-delete-analytics" },
      extra: { userId: job.data.userId, activityCount: job.data.activityIds.length },
    });
    throw error;
  }
}
