import type { Job, Queue } from "bullmq";
import { sql } from "drizzle-orm";
import type { SyncDatabase } from "../db/index.ts";
import { logger } from "../logger.ts";
import { getProvider, isSyncEligibleProvider } from "../providers/index.ts";
import { createProviderSyncQueue, type ScheduledSyncJobData, type SyncJobData } from "./queues.ts";

/**
 * Process a scheduled sync job: query all users with connected providers
 * and enqueue per-user sync jobs into per-provider queues so different
 * providers sync in parallel (while the same provider stays serialized).
 */
export async function processScheduledSyncJob(_job: Job<ScheduledSyncJobData>, db: SyncDatabase) {
  // Ensure provider registry is populated so provider metadata (type, auth) is available.
  const { ensureProvidersRegistered } = await import("./provider-registration.ts");
  await ensureProvidersRegistered();

  // Find all users who have at least one connected (non-import-only) provider
  const rows = await db.execute(
    sql`
      SELECT DISTINCT ot.user_id, ot.provider_id
      FROM fitness.oauth_token ot
    `,
  );

  // Group by user
  const userProviders = new Map<string, string[]>();
  for (const row of rows) {
    const userId = String(row.user_id);
    const providerId = String(row.provider_id);
    const providers = userProviders.get(userId) ?? [];
    providers.push(providerId);
    userProviders.set(userId, providers);
  }

  // Track per-provider queues so we can close them when done
  const openQueues = new Map<string, Queue<SyncJobData>>();
  let jobCount = 0;

  for (const [userId, providerIds] of userProviders) {
    for (const providerId of providerIds) {
      const provider = getProvider(providerId);
      if (provider && !isSyncEligibleProvider(provider)) {
        logger.info(`[scheduled-sync] Skipping CSV provider ${providerId}`);
        continue;
      }

      let queue = openQueues.get(providerId);
      if (!queue) {
        queue = createProviderSyncQueue(providerId);
        openQueues.set(providerId, queue);
      }

      await queue.add("sync", {
        userId,
        providerId,
        sinceDays: 1,
      });
      jobCount++;
    }
  }

  await Promise.all([...openQueues.values()].map((queue) => queue.close()));

  logger.info(`[scheduled-sync] Enqueued ${jobCount} sync jobs for ${userProviders.size} users`);
}
