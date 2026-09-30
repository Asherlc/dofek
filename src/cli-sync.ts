import { QueueEvents, Worker } from "bullmq";
import { parseSinceDays, resolveCliUserId } from "./cli.ts";
import { createDatabaseFromEnv } from "./db/index.ts";
import {
  createAccountErasureWorkLockPoolFromEnv,
  runQueuedUserWorkUnlessAccountErasing,
} from "./jobs/account-erasure-work-guard.ts";
import { processFitFileImportJob } from "./jobs/process-fit-file-import-job.ts";
import { processSyncJob } from "./jobs/process-sync-job.ts";
import { ensureProvidersRegistered } from "./jobs/provider-registration.ts";
import {
  createSyncQueue,
  FIT_FILE_IMPORT_QUEUE,
  type FitFileImportJobData,
  getRedisConnection,
  SYNC_JOB_RETRY_OPTIONS,
  SYNC_QUEUE,
  type SyncJobData,
} from "./jobs/queues.ts";
import { captureException } from "./lib/error-reporting.ts";
import { logger } from "./logger.ts";
import { getEnabledSyncProviders } from "./providers/index.ts";

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
  const accountErasureWorkLockPool = createAccountErasureWorkLockPoolFromEnv();
  const connection = getRedisConnection();
  const queue = createSyncQueue(connection);
  const userId = await resolveCliUserId(db);

  const jobs = await Promise.all(
    enabled.map((provider) =>
      queue.add(
        "sync",
        {
          providerId: provider.id,
          sinceDays: fullSync ? undefined : days,
          userId,
          origin: "manual",
        } satisfies SyncJobData,
        SYNC_JOB_RETRY_OPTIONS,
      ),
    ),
  );
  const label = fullSync ? "all time" : `last ${days} days`;
  logger.info(`[sync] Enqueued ${jobs.length} sync job(s), one per provider — ${label}`);

  // Process the job inline with a temporary worker
  const worker = new Worker<SyncJobData>(
    SYNC_QUEUE,
    (job, _token, signal) =>
      runQueuedUserWorkUnlessAccountErasing(
        accountErasureWorkLockPool,
        db,
        job.data.userId,
        "CLI provider sync",
        () => processSyncJob(job, db, signal),
      ),
    {
      connection,
    },
  );
  const fitFileImportWorker = new Worker<FitFileImportJobData>(
    FIT_FILE_IMPORT_QUEUE,
    (job) =>
      runQueuedUserWorkUnlessAccountErasing(
        accountErasureWorkLockPool,
        db,
        job.data.userId,
        "CLI FIT file import",
        () => processFitFileImportJob(job, db),
      ),
    { connection },
  );
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
    captureException(err, { tags: { phase: "cli-sync" } });
    logger.error(`[sync] Failed: ${err}`);
    return 1;
  } finally {
    await worker.close();
    await fitFileImportWorker.close();
    await queueEvents.close();
    await queue.close();
    await accountErasureWorkLockPool.close();
  }
}
