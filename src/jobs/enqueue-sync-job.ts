import type { Job, JobsOptions } from "bullmq";
import {
  providerRateLimitCooldownJobId,
  providerRateLimitCooldownStore,
  providerRateLimitDelayMs,
  type ProviderRateLimitCooldown,
} from "./provider-rate-limit-cooldown.ts";
import { getProviderSyncQueue, SYNC_JOB_RETRY_OPTIONS, type SyncJobData } from "./queues.ts";

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
): Promise<Job<SyncJobData>> {
  const options = await syncJobOptionsWithRateLimitCooldown(providerId, jobData.userId);
  return getProviderSyncQueue(providerId).add("sync", jobData, options);
}

export async function scheduleDelayedSyncJob(
  jobData: SyncJobData,
  cooldown: ProviderRateLimitCooldown,
): Promise<string> {
  const providerId = jobData.providerId ?? cooldown.providerId;
  const nextData: SyncJobData = {
    ...jobData,
    providerId,
  };
  await getProviderSyncQueue(providerId).add("sync", nextData, {
    ...SYNC_JOB_RETRY_OPTIONS,
    delay: providerRateLimitDelayMs(cooldown),
    jobId: providerRateLimitCooldownJobId(cooldown, jobData.userId),
  });
  return cooldown.expiresAt.toISOString();
}
