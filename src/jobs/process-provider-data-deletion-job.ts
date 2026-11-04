import { invalidateAllUserQueries } from "dofek/lib/cache";
import { captureException } from "../lib/error-reporting.ts";
import { logger } from "../logger.ts";
import {
  createMetricStreamProviderGenerationDeletedEvent,
  type MetricStreamProviderGenerationDeletedEvent,
} from "../metric-stream/events.ts";
import type {
  ProviderDeletionAcknowledgement,
  ProviderDeletionSourceKey,
} from "../metric-stream/provider-generation-deletion.ts";
import { type ProviderDataDeletionJobData, providerDataDeletionJobDataSchema } from "./queues.ts";

export interface ProviderDataDeletionJob {
  data: ProviderDataDeletionJobData;
  assertActive(): Promise<void>;
  deferUntilReceipt(): Promise<never>;
  updateData(data: ProviderDataDeletionJobData): Promise<void>;
  updateProgress(data: {
    checkpoint?: ProviderDataDeletionJobData["checkpoint"];
    message: string;
    percentage?: number;
  }): Promise<void>;
}

export interface ProviderDataDeletionDependencies {
  accountErasureAllowsWork(workKind: string): Promise<boolean>;
  publishProviderGenerationDeletion(
    command: MetricStreamProviderGenerationDeletedEvent,
  ): Promise<void>;
  readCommandAcknowledgement(
    command: MetricStreamProviderGenerationDeletedEvent,
  ): Promise<ProviderDeletionAcknowledgement | null>;
  readSourcePage(data: ProviderDataDeletionJobData): Promise<readonly ProviderDeletionSourceKey[]>;
  deleteProviderArtifacts(userId: string, providerId: string): Promise<void>;
  enqueueAnalyticsRefresh(
    userId: string,
    providerId: string,
    deletionEventId: string,
  ): Promise<void>;
  markCompleted(eventId: string): Promise<void>;
}

async function active<T>(job: ProviderDataDeletionJob, operation: () => Promise<T>): Promise<T> {
  await job.assertActive();
  const value = await operation();
  await job.assertActive();
  return value;
}

async function updateProgress(
  job: ProviderDataDeletionJob,
  percentage: number | undefined,
  message: string,
): Promise<void> {
  await active(job, async () => {
    try {
      await job.updateProgress({
        ...(percentage === undefined ? {} : { percentage }),
        message,
        checkpoint: job.data.checkpoint,
      });
    } catch (error) {
      captureException(error, { tags: { providerDataDeletionStep: "updateProgress" } });
      logger.warn(`[provider-data-deletion] Failed to update progress: ${String(error)}`);
    }
  });
}

/** One durable job owns the command chain; delayed steps never fork a batch job. */
export async function processProviderDataDeletionJob(
  job: ProviderDataDeletionJob,
  dependencies: ProviderDataDeletionDependencies,
): Promise<void> {
  job.data = providerDataDeletionJobDataSchema.parse(job.data);
  const allowed = (kind: string) => active(job, () => dependencies.accountErasureAllowsWork(kind));
  const save = async (data: ProviderDataDeletionJobData) => {
    await active(job, () => job.updateData(data));
    job.data = data;
  };
  if (!(await allowed("provider deletion command recovery"))) return;

  const pending = job.data.pendingCommand;
  if (pending) {
    const acknowledgement = await active(job, () =>
      dependencies.readCommandAcknowledgement(pending.command),
    );
    if (!acknowledgement) {
      if (!(await allowed("provider deletion command publication"))) return;
      await active(job, () => dependencies.publishProviderGenerationDeletion(pending.command));
      await job.assertActive();
      return job.deferUntilReceipt();
    }
    if (acknowledgement.effectCount > 1000n)
      throw new Error("Provider deletion receipt exceeds its bounded command page");
    const checkpoint = pending.nextCheckpoint
      ? {
          ...pending.nextCheckpoint,
          deletedRows: pending.nextCheckpoint.deletedRows + Number(acknowledgement.effectCount),
        }
      : job.data.checkpoint;
    await save({
      ...job.data,
      checkpoint,
      lastCommittedCommand: pending.command,
      pendingCommand: undefined,
    });
    await updateProgress(
      job,
      undefined,
      `Checked ${checkpoint?.examinedRows ?? 0} metric stream sources; deleted ${checkpoint?.deletedRows ?? 0}...`,
    );
  }

  const committed = job.data.lastCommittedCommand;
  if (committed) {
    const proof = await active(job, () => dependencies.readCommandAcknowledgement(committed));
    if (!proof)
      throw new Error(
        "Provider deletion committed command receipt is missing; do not reset its pending state, use verified operator recovery",
      );
    if (committed.complete) {
      if (!(await allowed("provider artifact deletion"))) return;
      await active(job, () =>
        dependencies.deleteProviderArtifacts(job.data.userId, job.data.providerId),
      );
      if (!(await allowed("provider deletion analytics enqueue"))) return;
      await active(job, () =>
        dependencies.enqueueAnalyticsRefresh(
          job.data.userId,
          job.data.providerId,
          job.data.eventId,
        ),
      );
      if (!(await allowed("provider deletion cache invalidation"))) return;
      await active(job, () => invalidateAllUserQueries(job.data.userId));
      if (!(await allowed("provider deletion completion"))) return;
      await active(job, () => dependencies.markCompleted(job.data.eventId));
      await updateProgress(job, 100, "Provider data deletion complete.");
      return;
    }
  }

  let sourceIds: string[] = [];
  let complete = false;
  let nextCheckpoint: ProviderDataDeletionJobData["checkpoint"];
  if (committed) {
    if (!(await allowed("provider deletion batch read"))) return;
    const sources = await active(job, () => dependencies.readSourcePage(job.data));
    if (sources.length > 1000)
      throw new Error("Provider deletion source page exceeds 1000 structural keys");
    sourceIds = [...new Set(sources.map((source) => source.id))];
    const last = sources.at(-1);
    complete = !last;
    if (last)
      nextCheckpoint = {
        batches: (job.data.checkpoint?.batches ?? 0) + 1,
        deletedRows: job.data.checkpoint?.deletedRows ?? 0,
        examinedRows: (job.data.checkpoint?.examinedRows ?? 0) + sources.length,
        lastGeneration: last.generation,
        lastId: last.id,
      };
  }
  const command = createMetricStreamProviderGenerationDeletedEvent({
    deletionEventId: job.data.eventId,
    userId: job.data.userId,
    providerId: job.data.providerId,
    generation: job.data.generation,
    sourceIds,
    complete,
    previousCommandId: committed?.commandId ?? null,
  });
  if (!(await allowed("provider deletion command preparation"))) return;
  await save({ ...job.data, pendingCommand: { command, nextCheckpoint } });
  if (!(await allowed("provider deletion command publication"))) return;
  await active(job, () => dependencies.publishProviderGenerationDeletion(command));
  await job.assertActive();
  return job.deferUntilReceipt();
}
