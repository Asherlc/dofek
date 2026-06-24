import type { Job } from "bullmq";
import { getProviderSyncQueue, type SyncJobData } from "../jobs/queues.ts";
import { syncApiQueryKey } from "./sync-api-query.ts";
import { resolveSyncRequestQuery } from "./sync-request-query.ts";

const PENDING_SYNC_JOB_STATES = ["active", "waiting", "delayed"] as const;

type PendingSyncJobState = (typeof PENDING_SYNC_JOB_STATES)[number];

export async function listProviderSyncJobsForUser(
  providerId: string,
  userId: string,
  states: readonly PendingSyncJobState[] = PENDING_SYNC_JOB_STATES,
): Promise<Job<SyncJobData>[]> {
  // TODO: getJobs fetches ALL pending jobs across all users for this provider,
  // filtering in memory. Profile if the queue grows large for shared providers.
  const jobs = await getProviderSyncQueue(providerId).getJobs([...states]);
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
