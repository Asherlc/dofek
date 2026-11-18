import { logger } from "../logger.ts";
import { providerPollingIntervalMinutes } from "./provider-queue-config.ts";
import { createScheduledSyncQueue } from "./queues.ts";

export const SCHEDULER_KEY = "scheduled-sync-all-users";

/**
 * Sets up a repeating BullMQ job scheduler that enqueues sync-all jobs
 * at a fixed interval. Each scheduled job triggers a fan-out that queries
 * all users with connected providers and enqueues per-user sync jobs.
 *
 * This only covers API-based providers (Strava, Wahoo, etc.).
 * HealthKit data must be pushed from the iOS app.
 */
export async function setupScheduledSync(
  regularMinutes = providerPollingIntervalMinutes("regular"),
) {
  for (const cadence of ["regular", "daily"] as const) {
    const queue = createScheduledSyncQueue(undefined, cadence);
    const schedulerKey = cadence === "regular" ? SCHEDULER_KEY : `${SCHEDULER_KEY}-daily`;
    const intervalMinutes =
      cadence === "regular" ? regularMinutes : providerPollingIntervalMinutes(cadence);
    try {
      await queue.upsertJobScheduler(
        schedulerKey,
        { every: intervalMinutes * 60_000 },
        {
          name: "scheduled-sync",
          data: { type: "scheduled-sync-all", cadence },
        },
      );
    } finally {
      await queue.close();
    }
    logger.info(`[scheduled-sync] Registered ${cadence} sync every ${intervalMinutes} minutes`);
  }
}
