import type { Job, JobsOptions } from "bullmq";
import { buildSyncRequestJobId, resolveSyncRequestQuery } from "../lib/sync-request-query.ts";
import type { SyncJobData } from "./queues.ts";

const DUPLICATE_REQUEST_JOB_STATES = new Set(["active", "waiting", "delayed"]);

export type EnqueuedSyncJob = Job<SyncJobData> & { alreadyQueued: boolean };

function withAlreadyQueuedState(job: Job<SyncJobData>, alreadyQueued: boolean): EnqueuedSyncJob {
  return Object.assign(job, { alreadyQueued });
}

export async function enqueueSyncJobWithRequestDedup(
  providerId: string,
  jobData: SyncJobData,
  jobOptions: JobsOptions,
  addJob: (name: string, data: SyncJobData, options: JobsOptions) => Promise<Job<SyncJobData>>,
  getJob: (jobId: string) => Promise<Job<SyncJobData> | undefined>,
): Promise<EnqueuedSyncJob | null> {
  const requestQuery = resolveSyncRequestQuery(providerId, jobData);
  const nextOptions: JobsOptions = { ...jobOptions };

  if (nextOptions.jobId == null && requestQuery) {
    nextOptions.jobId = buildSyncRequestJobId(providerId, jobData.userId, requestQuery);
  }

  if (nextOptions.jobId != null) {
    const existing = await getJob(nextOptions.jobId);
    if (existing) {
      const state = await existing.getState();
      if (DUPLICATE_REQUEST_JOB_STATES.has(state)) {
        return withAlreadyQueuedState(existing, true);
      }
      await existing.remove();
    }
  }

  const job = await addJob("sync", jobData, nextOptions);
  const wasLifecycleDeduplicated =
    nextOptions.deduplication != null &&
    nextOptions.jobId != null &&
    job.id != null &&
    String(job.id) !== nextOptions.jobId;
  return withAlreadyQueuedState(job, wasLifecycleDeduplicated);
}
