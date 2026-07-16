import * as Sentry from "@sentry/node";
import type { ConnectionOptions } from "bullmq";
import { z } from "zod";
import { logger } from "../logger.ts";
import { garminImportCheckpointSchema } from "./process-garmin-dump-import-job.ts";
import {
  createFitFileImportBatchQueue,
  createImportQueue,
  FIT_FILE_IMPORT_BATCH_QUEUE,
} from "./queues.ts";

const PROGRESS_DEBOUNCE_MS = 2_000;
const FIT_PROGRESS_START_PERCENTAGE = 45;
const FIT_PROGRESS_END_PERCENTAGE = 90;
const progressSchema = z.object({ percentage: z.number() }).passthrough();

interface ObservedFitJob {
  parent?: {
    id?: string;
    queueKey: string;
  };
}

class GarminImportProgressCoordinator {
  readonly #importQueue;
  readonly #batchQueue;
  readonly #pendingBatchIds = new Set<string>();
  #refreshTimer: ReturnType<typeof setTimeout> | null = null;
  #refreshInFlight: Promise<void> | null = null;

  constructor(connection?: ConnectionOptions) {
    this.#importQueue = createImportQueue(connection);
    this.#batchQueue = createFitFileImportBatchQueue(connection);
  }

  observeFitJob(job: ObservedFitJob): void {
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
    await Promise.all(
      batchIds.map(async (batchId) => {
        try {
          await this.#refreshBatchProgress(batchId);
        } catch (error) {
          Sentry.captureException(error, {
            tags: { garminDumpStep: "progress-refresh" },
            extra: { batchId },
          });
          logger.warn("Failed to refresh Garmin import progress for batch %s: %s", batchId, error);
        }
      }),
    );
  }

  async #refreshBatchProgress(batchId: string): Promise<void> {
    const batchJob = await this.#batchQueue.getJob(batchId);
    const importJobId = batchJob?.parent?.id;
    if (!importJobId) {
      return;
    }
    const importJob = await this.#importQueue.getJob(importJobId);
    if (!importJob || importJob.data.importType !== "garmin-dump") {
      return;
    }
    const checkpoint = garminImportCheckpointSchema.safeParse(importJob.data.checkpoint);
    if (!checkpoint.success || checkpoint.data.phase !== "waiting-children") {
      return;
    }

    const counts = await batchJob.getDependenciesCount({
      failed: true,
      ignored: true,
      processed: true,
      unprocessed: true,
    });
    const total = checkpoint.data.totalFitFiles;
    const processedCount = (counts.processed ?? 0) + (counts.ignored ?? 0);
    const done = Math.min(total, processedCount + (counts.failed ?? 0));
    const failedCount = Math.min(done, counts.failed ?? 0);
    const succeededCount = done - failedCount;
    const percentage =
      total === 0
        ? FIT_PROGRESS_END_PERCENTAGE
        : FIT_PROGRESS_START_PERCENTAGE +
          Math.floor(
            (done / total) * (FIT_PROGRESS_END_PERCENTAGE - FIT_PROGRESS_START_PERCENTAGE),
          );
    const currentProgress = progressSchema.safeParse(importJob.progress);
    if (currentProgress.success && currentProgress.data.percentage >= percentage) {
      return;
    }

    const message =
      failedCount > 0
        ? `Importing Garmin FIT activities (${succeededCount} of ${total} complete, ${failedCount} failed)...`
        : `Importing Garmin FIT activities (${done} of ${total} complete)...`;

    await importJob.updateProgress({
      percentage,
      message,
    });
  }
}

export function createGarminImportProgressCoordinator(connection?: ConnectionOptions) {
  return new GarminImportProgressCoordinator(connection);
}
