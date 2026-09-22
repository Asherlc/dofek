import type { JobsOptions } from "bullmq";
import {
  type ProviderRateLimitCooldown,
  providerRateLimitCooldownJobId,
  providerRateLimitCooldownStore,
  providerRateLimitDelayMs,
} from "./provider-rate-limit-cooldown.ts";
import { getProviderSyncQueue, SYNC_JOB_RETRY_OPTIONS, type SyncJobData } from "./queues.ts";
import { type EnqueuedSyncJob, enqueueSyncJobWithRequestDedup } from "./sync-request-job.ts";

export type EnqueueSyncJobOptions = {
  /** When active, skip enqueue instead of scheduling a duplicate delayed job. */
  skipWhenRateLimited?: boolean;
  /** Coalesce a user-triggered initial full sync until that job completes or fails. */
  singleFlightFullSync?: boolean;
};

function withRelativeRequestAnchor(jobData: SyncJobData): SyncJobData {
  if (
    jobData.requestedAtIso !== undefined ||
    (jobData.targetRefreshWindow?.type !== "days" &&
      (jobData.targetRefreshWindow !== undefined || jobData.sinceDays === undefined))
  ) {
    return jobData;
  }
  return { ...jobData, requestedAtIso: new Date().toISOString() };
}

function initialFullSyncDeduplicationId(
  providerId: string,
  jobData: SyncJobData,
  options?: EnqueueSyncJobOptions,
): string | undefined {
  if (
    !options?.singleFlightFullSync ||
    jobData.targetRefreshWindow?.type !== "full" ||
    jobData.checkpoint !== undefined
  ) {
    return undefined;
  }
  return `sync:full:${providerId}:${jobData.userId}`;
}

export async function syncJobOptionsWithRateLimitCooldown(
  providerId: string,
  userId: string,
): Promise<JobsOptions> {
  const cooldown = await providerRateLimitCooldownStore.getActive(providerId, userId);
  if (!cooldown) return SYNC_JOB_RETRY_OPTIONS;
  return {
    ...SYNC_JOB_RETRY_OPTIONS,
    delay: providerRateLimitDelayMs(cooldown),
    jobId: providerRateLimitCooldownJobId(cooldown, userId),
  };
}

export async function enqueueSyncJob(
  providerId: string,
  jobData: SyncJobData,
  options?: EnqueueSyncJobOptions,
): Promise<EnqueuedSyncJob | null> {
  const cooldown = await providerRateLimitCooldownStore.getActive(providerId, jobData.userId);
  if (cooldown && options?.skipWhenRateLimited) {
    return null;
  }
  const anchoredJobData = withRelativeRequestAnchor(jobData);
  const jobOptions = await syncJobOptionsWithRateLimitCooldown(providerId, jobData.userId);
  const deduplicationId = initialFullSyncDeduplicationId(providerId, anchoredJobData, options);
  const queue = getProviderSyncQueue(providerId);
  return enqueueSyncJobWithRequestDedup(
    providerId,
    anchoredJobData,
    deduplicationId ? { ...jobOptions, deduplication: { id: deduplicationId } } : jobOptions,
    (name, data, opts) => queue.add(name, data, opts),
    (jobId) => queue.getJob(jobId),
  );
}

export async function scheduleDelayedSyncJob(
  jobData: SyncJobData,
  cooldown: ProviderRateLimitCooldown,
): Promise<string> {
  const providerId = jobData.providerId ?? cooldown.providerId;
  const anchoredJobData = withRelativeRequestAnchor({ ...jobData, providerId });
  const queue = getProviderSyncQueue(providerId);
  await enqueueSyncJobWithRequestDedup(
    providerId,
    anchoredJobData,
    {
      ...SYNC_JOB_RETRY_OPTIONS,
      delay: providerRateLimitDelayMs(cooldown),
      jobId: providerRateLimitCooldownJobId(cooldown, jobData.userId ?? ""),
    },
    (name, data, opts) => queue.add(name, data, opts),
    (jobId) => queue.getJob(jobId),
  );
  return cooldown.expiresAt.toISOString();
}
