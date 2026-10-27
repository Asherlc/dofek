import type { ConnectionOptions } from "bullmq";
import { z } from "zod";
import { captureException } from "../lib/error-reporting.ts";
import { logger } from "../logger.ts";
import { garminImportCheckpointSchema } from "./process-garmin-dump-import-job.ts";
import {
  createFitFileImportBatchQueue,
  createImportQueue,
  FIT_FILE_IMPORT_BATCH_QUEUE,
} from "./queues.ts";

const PROGRESS_DEBOUNCE_MS = 2_000;
const FIT_PROGRESS_END_PERCENTAGE = 90;
const progressSchema = z
  .object({ percentage: z.number(), message: z.string().optional() })
  .passthrough();

interface ObservedFitJob {
  parent?: {
    id?: string;
    queueKey: string;
  };
}

type FitImportBatchQueue = ReturnType<typeof createFitFileImportBatchQueue>;
type FitImportBatchJob = NonNullable<Awaited<ReturnType<FitImportBatchQueue["getJob"]>>>;

class GarminImportProgressCoordinator {
  readonly #importQueue;
  readonly #batchQueue;
  readonly #pendingBatchIds = new Set<string>();
  #refreshTimer: ReturnType<typeof setTimeout> | null = null;
  #refreshInFlight: Promise<void> | null = null;
  #closing = false;

  constructor(connection?: ConnectionOptions) {
    this.#importQueue = createImportQueue(connection);
    this.#batchQueue = createFitFileImportBatchQueue(connection);
  }

  observeFitJob(job: ObservedFitJob): void {
    if (this.#closing) return;
    const parent = job.parent;
    if (!parent?.id || !parent.queueKey.endsWith(`:${FIT_FILE_IMPORT_BATCH_QUEUE}`)) {
      return;
    }

    this.#pendingBatchIds.add(parent.id);
    if (this.#refreshTimer || this.#refreshInFlight) {
      return;
    }
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = null;
      void this.#refreshPendingBatches();
    }, PROGRESS_DEBOUNCE_MS);
    this.#refreshTimer.unref();
  }

  async reconcile(): Promise<void> {
    const waitingJobs = await this.#importQueue.getJobs(["waiting-children"], 0, -1, false);
    const batchIds = waitingJobs.flatMap((job) => {
      if (job.data.importType !== "garmin-dump") {
        return [];
      }
      const checkpoint = garminImportCheckpointSchema.safeParse(job.data.checkpoint);
      return checkpoint.success && checkpoint.data.phase === "waiting-children"
        ? [checkpoint.data.batchId]
        : [];
    });
    for (const batchId of batchIds) {
      this.#pendingBatchIds.add(batchId);
    }
    await this.#refreshPendingBatches();
  }

  async close(): Promise<void> {
    this.#closing = true;
    clearTimeout(this.#refreshTimer ?? undefined);
    this.#refreshTimer = null;
    this.#pendingBatchIds.clear();
    await this.#refreshInFlight;
    await Promise.all([this.#importQueue.close(), this.#batchQueue.close()]);
  }

  async #refreshPendingBatches(): Promise<void> {
    if (this.#refreshInFlight) {
      await this.#refreshInFlight;
      return;
    }

    const refresh = async () => {
      while (this.#pendingBatchIds.size > 0) {
        const batchIds = [...this.#pendingBatchIds];
        this.#pendingBatchIds.clear();
        await this.#refreshBatchIds(batchIds);
      }
    };
    this.#refreshInFlight = refresh();
    try {
      await this.#refreshInFlight;
    } finally {
      this.#refreshInFlight = null;
    }
  }

  async #refreshBatchIds(batchIds: readonly string[]): Promise<void> {
    const batchJobs = await Promise.all(
      batchIds.map(async (batchId) => {
        try {
          return { batchId, batchJob: await this.#batchQueue.getJob(batchId) };
        } catch (error) {
          this.#reportRefreshFailure(batchId, error);
          return { batchId, batchJob: undefined };
        }
      }),
    );
    const refreshedImportIds = new Set<string>();
    const refreshableBatches = batchJobs.flatMap(({ batchId, batchJob }) => {
      const importJobId = batchJob?.parent?.id;
      if (!batchJob || !importJobId || refreshedImportIds.has(importJobId)) {
        return [];
      }
      refreshedImportIds.add(importJobId);
      return [{ batchId, batchJob }];
    });
    await Promise.all(
      refreshableBatches.map(async ({ batchId, batchJob }) => {
        try {
          await this.#refreshImportProgress(batchJob);
        } catch (error) {
          this.#reportRefreshFailure(batchId, error);
        }
      }),
    );
  }

  #reportRefreshFailure(batchId: string, error: unknown): void {
    captureException(error, {
      tags: { garminDumpStep: "progress-refresh" },
      extra: { batchId },
    });
    logger.warn("Failed to refresh Garmin import progress for batch %s: %s", batchId, error);
  }

  async #refreshImportProgress(observedBatchJob: FitImportBatchJob): Promise<void> {
    const importJobId = observedBatchJob.parent?.id;
    if (!importJobId) return;
    const importJob = await this.#importQueue.getJob(importJobId);
    if (importJob?.data.importType !== "garmin-dump") {
      return;
    }
    const checkpoint = garminImportCheckpointSchema.safeParse(importJob.data.checkpoint);
    if (!checkpoint.success || checkpoint.data.phase !== "waiting-children") {
      return;
    }

    const batchIds = checkpoint.data.batchIds ?? [checkpoint.data.batchId];
    const batchJobs = await Promise.all(
      batchIds.map((batchId) =>
        batchId === observedBatchJob.id
          ? Promise.resolve(observedBatchJob)
          : this.#batchQueue.getJob(batchId),
      ),
    );
    const missingBatchIds = batchIds.filter((_, index) => batchJobs[index] === undefined);
    if (missingBatchIds.length > 0) {
      throw new Error(
        `Garmin import ${importJobId} is missing FIT batch jobs: ${missingBatchIds.join(", ")}`,
      );
    }
    const existingBatchJobs = batchJobs.filter((batchJob) => batchJob !== undefined);
    const dependencyCounts = await Promise.all(
      existingBatchJobs.map((batchJob) =>
        batchJob.getDependenciesCount({
          failed: true,
          ignored: true,
          processed: true,
          unprocessed: true,
        }),
      ),
    );
    const total = checkpoint.data.totalFitFiles;
    const processedCount = dependencyCounts.reduce(
      (count, counts) => count + (counts.processed ?? 0) + (counts.ignored ?? 0),
      0,
    );
    const totalFailedCount = dependencyCounts.reduce(
      (count, counts) => count + (counts.failed ?? 0),
      0,
    );
    const done = Math.min(total, processedCount + totalFailedCount);
    const failedCount = Math.min(done, totalFailedCount);
    const succeededCount = done - failedCount;
    const percentage =
      total === 0 ? FIT_PROGRESS_END_PERCENTAGE : (done / total) * FIT_PROGRESS_END_PERCENTAGE;
    const message = `Importing Garmin FIT activities (${succeededCount} succeeded, ${failedCount} failed, ${done} of ${total} processed)...`;
    const currentProgress = progressSchema.safeParse(importJob.progress);
    if (
      currentProgress.success &&
      (currentProgress.data.percentage > percentage ||
        (currentProgress.data.percentage === percentage &&
          currentProgress.data.message === message))
    ) {
      return;
    }

    await importJob.updateProgress({
      percentage,
      message,
      ...(failedCount > 0 ? { failedCount } : {}),
    });
  }
}

export function createGarminImportProgressCoordinator(connection?: ConnectionOptions) {
  return new GarminImportProgressCoordinator(connection);
}
