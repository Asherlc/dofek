import { QueueEvents, Worker } from "bullmq";
import { parseSinceDays } from "../cli.ts";
import { createDatabaseFromEnv } from "../db/index.ts";
import { processSyncJob } from "../jobs/process-sync-job.ts";
import { ensureProvidersRegistered } from "../jobs/provider-registration.ts";
import {
  createSyncQueue,
  getRedisConnection,
  SYNC_QUEUE,
  type SyncJobData,
} from "../jobs/queues.ts";
import { logger } from "../logger.ts";
import { getEnabledSyncProviders } from "../providers/index.ts";
import { resolveCliUserId } from "./utils.ts";

export async function handleSyncCommand(args: string[]): Promise<number> {
  const fullSync = args.includes("--full-sync");
  const days = parseSinceDays(args);

  // Register all providers so processSyncJob can use them
  await ensureProvidersRegistered();

  const enabled = getEnabledSyncProviders();
  if (enabled.length === 0) {
    logger.info("[sync] No syncable providers enabled. Set API keys in .env to enable providers.");
    return 0;
  }

  const db = createDatabaseFromEnv();
  const connection = getRedisConnection();
  const queue = createSyncQueue(connection);
  const userId = await resolveCliUserId(db);

  const jobs = await Promise.all(
    enabled.map((provider) =>
      queue.add("sync", {
        providerId: provider.id,
        sinceDays: fullSync ? undefined : days,
        userId,
      } satisfies SyncJobData),
    ),
  );
  const label = fullSync ? "all time" : `last ${days} days`;
  logger.info(`[sync] Enqueued ${jobs.length} sync job(s), one per provider — ${label}`);

  // Process the job inline with a temporary worker
  const worker = new Worker<SyncJobData>(SYNC_QUEUE, (j) => processSyncJob(j, db), {
    connection,
  });
  const queueEvents = new QueueEvents(SYNC_QUEUE, { connection });

  try {
    const results = await Promise.allSettled(jobs.map((job) => job.waitUntilFinished(queueEvents)));
    const failed = results.find((result) => result.status === "rejected");
    if (failed) {
      throw failed.reason;
    }
    logger.info("[sync] Done.");
    return 0;
  } catch (err) {
    logger.error(`[sync] Failed: ${err}`);
    return 1;
  } finally {
    await worker.close();
    await queueEvents.close();
    await queue.close();
  }
}
