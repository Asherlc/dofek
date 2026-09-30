import { withAccountErasureUserWriteFence } from "../db/account-erasure.ts";
import type { SyncDatabase } from "../db/index.ts";
import { captureException } from "../lib/error-reporting.ts";
import { logger } from "../logger.ts";
import type { MetricStreamProcessingPublisher } from "../processing/metric-stream-processing-publisher.ts";
import { SyncRun } from "../providers/sync-run.ts";
import type { SyncCheckpointStore, SyncProvider } from "../providers/types.ts";
import { enqueueSyncJob } from "./enqueue-sync-job.ts";
import type { SyncJob } from "./queues.ts";
import { syncRequestedAtFromJobData, syncWindowFromJobData } from "./sync-job-window.ts";
import { requireTransactionalSyncDatabase } from "./sync-processing-operation.ts";

/**
 * Compute overall job percentage from completed providers + within-provider progress.
 * Each provider gets an equal slice of the total (e.g., 3 providers = 33% each).
 * Within-provider progress subdivides that slice.
 */
function computePercentage(
  completedProviders: number,
  withinProviderPct: number,
  totalProviders: number,
): number {
  if (totalProviders === 0) return 100;
  const perProvider = 100 / totalProviders;
  return Math.round(completedProviders * perProvider + (withinProviderPct / 100) * perProvider);
}

function createCheckpointStore(job: SyncJob): SyncCheckpointStore {
  return {
    load: async () => job.data.checkpoint ?? null,
    save: async (checkpoint: unknown) => {
      const nextData = { ...job.data, checkpoint };
      await job.updateData(nextData);
      job.data = nextData;
    },
    clear: async () => {
      const { checkpoint: _checkpoint, ...nextData } = job.data;
      await job.updateData(nextData);
      job.data = nextData;
    },
  };
}

/** Shared job window, durable continuation state and provider progress. */
export class SyncJobContext {
  completedCount = 0;
  totalProviders = 0;
  providerStatus: Record<string, { status: string; message?: string }> = {};
  syncRunContinued = false;
  constructor(
    readonly job: SyncJob,
    readonly db: SyncDatabase,
    readonly signal: AbortSignal | undefined,
    readonly requestedAt: Date,
    readonly relativeWindow: boolean,
    readonly syncWindow: ReturnType<typeof syncWindowFromJobData>,
  ) {}
  static async create(
    job: SyncJob,
    db: SyncDatabase,
    signal?: AbortSignal,
  ): Promise<SyncJobContext> {
    signal?.throwIfAborted();
    const startedAt = new Date();
    const relativeWindow =
      job.data.targetRefreshWindow?.type === "days" ||
      (job.data.targetRefreshWindow === undefined && job.data.sinceDays !== undefined);
    if (
      (job.data.origin === "scheduled" || relativeWindow) &&
      job.data.requestedAtIso === undefined
    ) {
      const nextData = { ...job.data, requestedAtIso: startedAt.toISOString() };
      await job.updateData(nextData);
      job.data = nextData;
      signal?.throwIfAborted();
    }
    const requestedAt = syncRequestedAtFromJobData(job.data, startedAt);
    const syncWindow = syncWindowFromJobData(job.data, requestedAt);

    return new SyncJobContext(job, db, signal, requestedAt, relativeWindow, syncWindow);
  }
  async initializeProviders(providers: readonly SyncProvider[]): Promise<void> {
    this.totalProviders = providers.length;
    for (const provider of providers) this.providerStatus[provider.id] = { status: "pending" };
    await this.job.updateProgress({ providers: this.providerStatus, percentage: 0 });
  }
  percentage(withinProviderPct: number): number {
    return computePercentage(this.completedCount, withinProviderPct, this.totalProviders);
  }
  createRun(
    provider: SyncProvider,
    metricStreamPublisher?: MetricStreamProcessingPublisher,
  ): SyncRun {
    const { job, db, signal } = this;
    const { since, until } = this.syncWindow;
    return new SyncRun({
      db,
      window: this.syncWindow,
      signal,
      origin: job.data.origin ?? "unknown",
      requestedAt: this.requestedAt,
      relativeWindow: this.relativeWindow,
      onProgress: (percentage, message) => {
        this.providerStatus[provider.id] = { status: "running", message };
        job
          .updateProgress({
            providers: this.providerStatus,
            percentage: this.percentage(percentage),
          })
          .catch((error: unknown) => {
            captureException(error, {
              tags: { provider: provider.id, syncStep: "updateProgress" },
            });
            logger.warn(
              `[worker] Failed to update sync progress for ${provider.id}: ${String(error)}`,
            );
          });
      },
      userId: job.data.userId,
      metricStreamPublisher,
      checkpoint: createCheckpointStore(job),
      enqueueSyncContinuation: async (checkpoint) => {
        signal?.throwIfAborted();
        await withAccountErasureUserWriteFence(
          requireTransactionalSyncDatabase(db),
          job.data.userId,
          async () => {
            signal?.throwIfAborted();
            await enqueueSyncJob(provider.id, {
              ...job.data,
              providerId: provider.id,
              sinceIso: since.toISOString(),
              untilIso: until.toISOString(),
              checkpoint,
            });
          },
        );
      },
    });
  }
}
