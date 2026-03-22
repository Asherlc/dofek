import { logger } from "../logger.ts";
import { createScheduledSyncQueue } from "./queues.ts";

export const SCHEDULER_KEY = "scheduled-sync-all-users";
const DEFAULT_INTERVAL_MINUTES = 30;

/**
 * Sets up a repeating BullMQ job scheduler that enqueues sync-all jobs
 * at a fixed interval. Each scheduled job triggers a fan-out that queries
 * all users with connected providers and enqueues per-user sync jobs.
 *
 * This only covers API-based providers (Strava, Wahoo, etc.).
 * HealthKit data must be pushed from the iOS app.
 */
export async function setupScheduledSync(intervalMinutes = DEFAULT_INTERVAL_MINUTES) {
  const queue = createScheduledSyncQueue();
  const intervalMs = intervalMinutes * 60 * 1000;

  await queue.upsertJobScheduler(
    SCHEDULER_KEY,
    { every: intervalMs },
    {
      name: "scheduled-sync",
      data: { type: "scheduled-sync-all" as const },
    },
  );

  logger.info(`[scheduled-sync] Registered repeatable sync every ${intervalMinutes} minutes`);
}
