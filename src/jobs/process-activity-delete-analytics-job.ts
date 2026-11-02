import {
  waitForPeerDbActivityDeletes,
  waitForPeerDbActivityRestores,
  waitForPeerDbProviderDeletes,
} from "../analytics/activity-read-model-build.ts";
import { refreshAnalyticsAndWait } from "../analytics-refresh-queue.ts";
import { createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import type { Database } from "../db/index.ts";
import { invalidateAllUserQueries } from "../lib/cache.ts";
import { captureException } from "../lib/error-reporting.ts";
import { logger } from "../logger.ts";
import {
  type AccountErasureWorkLockPool,
  accountErasureAllowsQueuedUserWork,
} from "./account-erasure-work-guard.ts";
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
    captureException(error, { tags: { activityAnalyticsStep: "updateProgress" } });
  });
}

async function finishActivityAnalytics(
  job: ActivityAnalyticsJob,
  database: Pick<Database, "execute">,
  workLockPool: AccountErasureWorkLockPool,
  userId: string,
  logMessage: string,
  provider = false,
): Promise<void> {
  // Read-only CDC/refresh waits must not prevent account erasure. Only the
  // cache write needs the shared lock and an erasure check inside that lock.
  await workLockPool.runWithSharedUserLock(userId, async () => {
    if (
      !(await accountErasureAllowsQueuedUserWork(
        database,
        userId,
        "activity analytics cache invalidation",
      ))
    )
      return;
    await updateActivityAnalyticsProgress(
      job,
      90,
      provider
        ? "Invalidating provider analytics cache..."
        : "Invalidating activity analytics cache...",
    );
    await invalidateAllUserQueries(userId);
    logger.info(logMessage);
    await updateActivityAnalyticsProgress(
      job,
      100,
      provider ? "Provider analytics refresh complete." : "Activity analytics refresh complete.",
    );
  });
}

async function rebuildActivityAnalytics(
  job: ActivityAnalyticsJob,
  database: Pick<Database, "execute">,
  userId: string,
  logMessage: string,
  workLockPool: AccountErasureWorkLockPool,
): Promise<void> {
  if (
    !(await accountErasureAllowsQueuedUserWork(database, userId, "activity read-model rebuild"))
  ) {
    return;
  }
  await updateActivityAnalyticsProgress(job, 60, "Rebuilding activity analytics...");
  await refreshAnalyticsAndWait();
  await finishActivityAnalytics(job, database, workLockPool, userId, logMessage);
}

export async function processActivityDeleteAnalyticsJob(
  job: ActivityAnalyticsJob,
  database: Pick<Database, "execute">,
  workLockPool: AccountErasureWorkLockPool,
): Promise<void> {
  const { userId } = job.data;
  if (!(await accountErasureAllowsQueuedUserWork(database, userId, "activity analytics refresh"))) {
    return;
  }
  const client = createClickHouseClientFromEnv();

  try {
    await updateActivityAnalyticsProgress(job, 0, "Starting activity analytics refresh...");
    if (job.data.type === "provider-delete-analytics-refresh") {
      if (
        !(await accountErasureAllowsQueuedUserWork(
          database,
          userId,
          "provider deletion analytics wait",
        ))
      ) {
        return;
      }
      await updateActivityAnalyticsProgress(
        job,
        20,
        "Waiting for provider records to reach analytics...",
      );
      await waitForPeerDbProviderDeletes(client, userId, job.data.providerId);
      if (
        !(await accountErasureAllowsQueuedUserWork(
          database,
          userId,
          "provider deletion read-model rebuild",
        ))
      ) {
        return;
      }
      await updateActivityAnalyticsProgress(job, 60, "Rebuilding provider analytics...");
      await refreshAnalyticsAndWait();
      await finishActivityAnalytics(
        job,
        database,
        workLockPool,
        userId,
        `[provider-delete-analytics] Refreshed all read models after deleting provider ${job.data.providerId}`,
        true,
      );

      return;
    }
    const { activityIds } = job.data;
    if (job.data.type === "activity-recompute-analytics-refresh") {
      await rebuildActivityAnalytics(
        job,
        database,
        userId,
        `[activity-recompute-analytics] Refreshed activity read models for ${activityIds.length} activities`,
        workLockPool,
      );
      return;
    }

    if (job.data.type === "activity-restore-analytics-refresh") {
      if (
        !(await accountErasureAllowsQueuedUserWork(
          database,
          userId,
          "activity restore analytics wait",
        ))
      ) {
        return;
      }
      await updateActivityAnalyticsProgress(
        job,
        20,
        "Waiting for activity restores to reach analytics...",
      );
      await waitForPeerDbActivityRestores(client, activityIds);
      await rebuildActivityAnalytics(
        job,
        database,
        userId,
        `[activity-restore-analytics] Refreshed activity read models after restoring ${activityIds.length} activities`,
        workLockPool,
      );
      return;
    }

    if (
      !(await accountErasureAllowsQueuedUserWork(
        database,
        userId,
        "activity deletion analytics wait",
      ))
    ) {
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
      database,
      userId,
      `[activity-delete-analytics] Refreshed activity read models after deleting ${activityIds.length} activities`,
      workLockPool,
    );
  } finally {
    await client.close?.();
  }
}
