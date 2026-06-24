import type { Job, JobsOptions } from "bullmq";
import { buildSyncRequestJobId, resolveSyncRequestQuery } from "../lib/sync-request-query.ts";
import type { SyncJobData } from "./queues.ts";

const DUPLICATE_REQUEST_JOB_STATES = new Set(["active", "waiting", "delayed"]);

export async function enqueueSyncJobWithRequestDedup(
  providerId: string,
  jobData: SyncJobData,
  jobOptions: JobsOptions,
  addJob: (name: string, data: SyncJobData, options: JobsOptions) => Promise<Job<SyncJobData>>,
  getJob: (jobId: string) => Promise<Job<SyncJobData> | undefined>,
): Promise<Job<SyncJobData> | null> {
  const requestQuery = resolveSyncRequestQuery(providerId, jobData);
  const nextOptions: JobsOptions = { ...jobOptions };

  if (requestQuery && nextOptions.jobId == null) {
    nextOptions.jobId = buildSyncRequestJobId(providerId, jobData.userId, requestQuery);
    const existing = await getJob(nextOptions.jobId);
    if (existing) {
      const state = await existing.getState();
      if (DUPLICATE_REQUEST_JOB_STATES.has(state)) {
        return existing;
      }
      await existing.remove();
    }
  }

  return addJob("sync", jobData, nextOptions);
}
