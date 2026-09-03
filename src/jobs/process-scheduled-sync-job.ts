import { isStepChainSyncProvider } from "@dofek/provider-http/adaptive-rate-limit";
import { sql } from "drizzle-orm";
import {
  AccountErasureUserFencedError,
  withAccountErasureUserWriteFence,
} from "../db/account-erasure.ts";
import type { Database, SyncDatabase } from "../db/index.ts";
import { listProviderSyncJobsForUser } from "../lib/sync-request-queue.ts";
import { logger } from "../logger.ts";
import { getProvider, isSyncEligibleProvider } from "../providers/index.ts";
import { enqueueSyncJob } from "./enqueue-sync-job.ts";
import { reportJobProgress } from "./job-progress.ts";
import type { ScheduledSyncJobData, SyncJobData } from "./queues.ts";

interface ScheduledSyncJob {
  data: ScheduledSyncJobData;
  updateProgress: (data: { percentage: number; message: string }) => Promise<void>;
}

async function updateScheduledSyncProgress(
  job: ScheduledSyncJob,
  percentage: number,
  message: string,
): Promise<void> {
  await reportJobProgress(
    job,
    percentage,
    message,
    "Failed to update scheduled sync progress: %s",
    "scheduledSyncStep",
  );
}

/**
 * Process a scheduled sync job: query all users with connected providers
 * and enqueue per-user sync jobs into per-provider queues so different
 * providers sync in parallel (while the same provider stays serialized).
 */
type ScheduledSyncDatabase = SyncDatabase & Pick<Database, "transaction">;

export async function processScheduledSyncJob(job: ScheduledSyncJob, db: ScheduledSyncDatabase) {
  await updateScheduledSyncProgress(job, 0, "Starting scheduled sync dispatch...");
  // Ensure provider registry is populated so provider metadata (type, auth) is available.
  const { ensureProvidersRegistered } = await import("./provider-registration.ts");
  await ensureProvidersRegistered();

  await updateScheduledSyncProgress(job, 10, "Loading connected providers...");
  // Find every explicit user/provider connection. Non-sync sources are filtered below.
  const rows = await db.execute(
    sql`
      SELECT pc.user_id, pc.provider_id
      FROM fitness.provider_connection pc
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

  const totalProviderConnections = Array.from(userProviders.values()).reduce(
    (totalConnections, providerIds) => totalConnections + providerIds.length,
    0,
  );
  await updateScheduledSyncProgress(
    job,
    25,
    `Found ${totalProviderConnections} provider connections for ${userProviders.size} users.`,
  );

  let jobCount = 0;
  let skippedDueToCooldown = 0;
  let skippedDueToInFlight = 0;
  let processedConnections = 0;

  async function reportDispatchProgress(): Promise<void> {
    const skippedCount = skippedDueToCooldown + skippedDueToInFlight;
    await updateScheduledSyncProgress(
      job,
      Math.round(25 + (processedConnections / totalProviderConnections) * 70),
      `Scheduled ${jobCount} sync jobs, skipped ${skippedCount}.`,
    );
  }

  for (const [userId, providerIds] of userProviders) {
    try {
      await withAccountErasureUserWriteFence(db, userId, async () => {
        for (const providerId of providerIds) {
          const provider = getProvider(providerId);
          if (!provider || !isSyncEligibleProvider(provider)) {
            logger.info(`[scheduled-sync] Skipping non-sync provider ${providerId}`);
            processedConnections++;
            await reportDispatchProgress();
            continue;
          }

          if (isStepChainSyncProvider(providerId)) {
            const pendingJobs = await listProviderSyncJobsForUser(providerId, userId);
            if (pendingJobs.length > 0) {
              skippedDueToInFlight++;
              logger.info(
                `[scheduled-sync] Skipping ${providerId} for ${userId}: ${pendingJobs.length} sync job(s) already queued`,
              );
              processedConnections++;
              await reportDispatchProgress();
              continue;
            }
          }

          const jobData = {
            userId,
            providerId,
            sinceDays: provider.scheduledSyncLookbackDays ?? 1,
            origin: "scheduled",
          } satisfies SyncJobData;

          const syncJob = await enqueueSyncJob(providerId, jobData, {
            skipWhenRateLimited: true,
          });
          if (!syncJob) {
            skippedDueToCooldown++;
            logger.info(
              `[scheduled-sync] Skipping ${providerId} for ${userId}: rate-limit cooldown active`,
            );
            processedConnections++;
            await reportDispatchProgress();
            continue;
          }
          jobCount++;
          processedConnections++;
          await reportDispatchProgress();
        }
      });
    } catch (error: unknown) {
      if (!(error instanceof AccountErasureUserFencedError)) throw error;
      processedConnections += providerIds.length;
      logger.info("[scheduled-sync] Skipping one account with active erasure");
      await reportDispatchProgress();
    }
  }

  await updateScheduledSyncProgress(
    job,
    100,
    `Scheduled ${jobCount} sync jobs for ${userProviders.size} users.`,
  );

  logger.info(
    `[scheduled-sync] Enqueued ${jobCount} sync jobs for ${userProviders.size} users` +
      (skippedDueToCooldown > 0
        ? ` (${skippedDueToCooldown} skipped due to rate-limit cooldown)`
        : "") +
      (skippedDueToInFlight > 0 ? ` (${skippedDueToInFlight} skipped due to in-flight sync)` : ""),
  );
}
