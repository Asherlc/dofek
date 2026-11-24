import { hostname } from "node:os";
import type { SyncDatabase } from "../db/index.ts";
import { jobContext, logger } from "../logger.ts";
import {
  type AccountErasureWorkLockPool,
  runQueuedUserWorkUnlessAccountErasing,
} from "./account-erasure-work-guard.ts";
import { processSyncJob } from "./process-sync-job.ts";
import type { SyncJob } from "./queues.ts";

type ProviderSyncJob = SyncJob & { attemptsStarted: number; log(row: string): Promise<number> };

export function createProviderSyncProcessor(
  db: SyncDatabase,
  workLockPool: AccountErasureWorkLockPool,
) {
  const workerSite = process.env.SYNC_WORKER_SITE ?? "local";
  const workerInstance =
    process.env.SYNC_WORKER_INSTANCE ?? process.env.FLY_MACHINE_ID ?? hostname();

  return async (job: ProviderSyncJob, _token?: string, signal?: AbortSignal): Promise<void> => {
    const startedAt = performance.now();
    const providerId = job.data.providerId;
    let outcome: "returned" | "threw" = "returned";
    try {
      await jobContext.run(job, () =>
        runQueuedUserWorkUnlessAccountErasing(
          workLockPool,
          db,
          job.data.userId,
          "provider sync",
          () => processSyncJob(job, db, signal),
          providerId,
        ),
      );
    } catch (error) {
      outcome = "threw";
      throw error;
    } finally {
      logger.info("Provider sync attempt finished", {
        event: "provider_sync_attempt_finished",
        worker_site: workerSite,
        worker_instance: workerInstance,
        provider_id: providerId,
        queue: job.queueQualifiedName,
        attempt: job.attemptsStarted,
        outcome,
        duration_ms: Math.round(performance.now() - startedAt),
      });
    }
  };
}
