import { withAccountErasureUserWriteFence } from "../db/account-erasure.ts";
import type { SyncDatabase } from "../db/index.ts";
import { captureException } from "../lib/error-reporting.ts";
import { logger } from "../logger.ts";
import { type SyncJob, SyncJobContext } from "./sync-job-context.ts";
import { requireTransactionalSyncDatabase } from "./sync-processing-operation.ts";
import { executeSyncProvider } from "./sync-provider-execution.ts";

export async function processSyncJob(
  job: SyncJob,
  db: SyncDatabase,
  signal?: AbortSignal,
): Promise<void> {
  const context = await SyncJobContext.create(job, db, signal);
  const { providerId } = job.data;
  // Lazy-import provider registration
  const { ensureProvidersRegistered } = await import("./provider-registration.ts");
  await ensureProvidersRegistered();

  const { getEnabledSyncProviders, getProvider, isSyncEligibleProvider } = await import(
    "../providers/index.ts"
  );

  let providers = getEnabledSyncProviders();
  if (providerId) {
    const registeredProvider = getProvider(providerId);
    if (registeredProvider && !isSyncEligibleProvider(registeredProvider)) {
      logger.info(`[worker] Skipping non-sync provider in sync queue: ${providerId}`);
      await job.updateProgress({
        providers: { [providerId]: { status: "done", message: "Skipped file-import provider" } },
        percentage: 100,
      });
      return;
    }
    const specific = providers.find((p) => p.id === providerId);
    if (!specific) throw new Error(`Unknown provider: ${providerId}`);
    providers = [specific];
  }

  await context.initializeProviders(providers);
  for (const provider of providers) {
    if (!(await executeSyncProvider(context, provider))) return;
  }
  if (context.syncRunContinued && context.deferredOpenBetaError === undefined) {
    return;
  }

  if (signal?.aborted) {
    // A provider SyncResult (including cancel-with-commits) already logged and
    // invalidated above. Skip post-sync without failing the job. Pre-provider
    // cancellation still rejects via throwIfAborted when nothing completed.
    if (context.completedCount > 0) {
      return;
    }
    signal.throwIfAborted();
  }
  try {
    const { enqueueDebouncedPostSyncMaintenance } = await import("./queues.ts");
    await enqueueDebouncedPostSyncMaintenance();
  } catch (err) {
    signal?.throwIfAborted();
    logger.error(`[worker] Failed to enqueue global post-sync maintenance: ${err}`);
    captureException(err, { tags: { phase: "post-sync-global-maintenance-enqueue" } });
  }

  signal?.throwIfAborted();
  try {
    const { enqueueDebouncedUserRefit } = await import("./queues.ts");
    await withAccountErasureUserWriteFence(
      requireTransactionalSyncDatabase(db),
      job.data.userId,
      async () => {
        signal?.throwIfAborted();
        await enqueueDebouncedUserRefit(job.data.userId);
        signal?.throwIfAborted();
      },
    );
    signal?.throwIfAborted();
  } catch (err) {
    signal?.throwIfAborted();
    logger.error(`[worker] Failed to enqueue user refit: ${err}`);
    captureException(err, { tags: { phase: "post-sync-user-refit-enqueue" } });
  }
  if (context.deferredOpenBetaError !== undefined) throw context.deferredOpenBetaError;
}
