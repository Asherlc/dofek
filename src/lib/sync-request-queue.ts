import type { Job } from "bullmq";
import { getProviderSyncQueue, type SyncJobData } from "../jobs/queues.ts";
import { syncApiQueryKey } from "./sync-api-query.ts";
import { resolveSyncRequestQuery } from "./sync-request-query.ts";

export async function listProviderSyncJobsForUser(
  providerId: string,
  userId: string,
): Promise<Job<SyncJobData>[]> {
  const queue = getProviderSyncQueue(providerId);
  const [active, waiting, delayed] = await Promise.all([
    queue.getActive(),
    queue.getWaiting(),
    queue.getDelayed(),
  ]);
  const jobs = [...active, ...waiting, ...delayed];
  return jobs.filter((job) => job.data.userId === userId);
}

export async function listPendingSyncRequestQueryKeys(
  providerId: string,
  userId: string,
): Promise<Set<string>> {
  const jobs = await listProviderSyncJobsForUser(providerId, userId);
  const keys = new Set<string>();
  for (const job of jobs) {
    const query = resolveSyncRequestQuery(providerId, job.data);
    if (query) {
      keys.add(syncApiQueryKey(query));
    }
  }
  return keys;
}
