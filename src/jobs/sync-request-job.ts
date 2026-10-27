import { createHash } from "node:crypto";
import type { Job, JobsOptions } from "bullmq";
import { buildSyncRequestJobId, resolveSyncRequestQuery } from "../lib/sync-request-query.ts";
import type { SyncJobData } from "./queues.ts";

const DUPLICATE_REQUEST_JOB_STATES = new Set(["active", "waiting", "delayed"]);

export type EnqueuedSyncJob = Job<SyncJobData> & { alreadyQueued: boolean };

function withAlreadyQueuedState(job: Job<SyncJobData>, alreadyQueued: boolean): EnqueuedSyncJob {
  return Object.assign(job, { alreadyQueued });
}

function syncCoordinatorChildJobId(
  coordinatorId: string,
  providerId: string,
  userId: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([coordinatorId, providerId, userId]))
    .digest("hex");
  return `sync-dispatch-${digest}`;
}

export function syncCoordinatorHasDispatchedProvider(
  dependencies: Awaited<ReturnType<Job<SyncJobData>["getDependencies"]>>,
  coordinatorId: string,
  providerId: string,
  userId: string,
): boolean {
  const childId = syncCoordinatorChildJobId(coordinatorId, providerId, userId);
  return [
    ...Object.keys(dependencies.processed ?? {}),
    ...Object.keys(dependencies.ignored ?? {}),
    ...(dependencies.unprocessed ?? []),
    ...(dependencies.failed ?? []),
  ].some((key) => key.endsWith(`:${childId}`));
}

export async function enqueueSyncJobWithRequestDedup(
  providerId: string,
  jobData: SyncJobData,
  jobOptions: JobsOptions,
  addJob: (name: string, data: SyncJobData, options: JobsOptions) => Promise<Job<SyncJobData>>,
  getJob: (jobId: string) => Promise<Job<SyncJobData> | undefined>,
  coordinator?: { id: string; queueQualifiedName: string },
): Promise<EnqueuedSyncJob | null> {
  const requestQuery = resolveSyncRequestQuery(providerId, jobData);
  const nextOptions: JobsOptions = { ...jobOptions };

  if (coordinator !== undefined) {
    nextOptions.jobId = syncCoordinatorChildJobId(coordinator.id, providerId, jobData.userId);
    nextOptions.parent = { id: coordinator.id, queue: coordinator.queueQualifiedName };
    nextOptions.ignoreDependencyOnFailure = true;
  }

  if (nextOptions.jobId == null && requestQuery) {
    nextOptions.jobId = buildSyncRequestJobId(providerId, jobData.userId, requestQuery);
  }

  if (nextOptions.jobId != null) {
    const existing = await getJob(nextOptions.jobId);
    if (existing) {
      const state = await existing.getState();
      if (
        DUPLICATE_REQUEST_JOB_STATES.has(state) ||
        (coordinator !== undefined && (state === "completed" || state === "failed"))
      ) {
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
