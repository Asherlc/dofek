import { Job, UnrecoverableError, WaitingChildrenError, Worker } from "bullmq";
import type { createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import type { createDatabaseFromEnv } from "../db/index.ts";
import type { createRefitSensorStore } from "../db/refit-sensor-store.ts";
import type { createImportUploadStorageFromEnv } from "../file-upload-storage.ts";
import { jobContext, logger } from "../logger.ts";
import type { createAccountErasureRuntime } from "./account-erasure-runtime.ts";
import {
  accountErasureAllowsQueuedUserWork,
  type createAccountErasureWorkLockPoolFromEnv,
  runQueuedUserWorkUnlessAccountErasing,
} from "./account-erasure-work-guard.ts";
import { createAccountErasureWorker } from "./account-erasure-worker.ts";
import { processActivityDeleteAnalyticsJob } from "./process-activity-delete-analytics-job.ts";
import { processExportJob } from "./process-export-job.ts";
import { processFileUploadImportJob } from "./process-file-upload-import-job.ts";
import { processFitFileImportBatchJob } from "./process-fit-file-import-batch-job.ts";
import { processFitFileImportJob } from "./process-fit-file-import-job.ts";
import { processPostSyncJob } from "./process-post-sync-job.ts";
import { processProviderDataDeletionJob } from "./process-provider-data-deletion-job.ts";
import { processScheduledSyncJob } from "./process-scheduled-sync-job.ts";
import { processSyncJob } from "./process-sync-job.ts";
import { processZipEntryExtractJob } from "./process-zip-entry-extract-job.ts";
import { createProviderDataDeletionDependencies } from "./provider-data-deletion-dependencies.ts";
import { getConfiguredProviderIds, getProviderQueueConfig } from "./provider-queue-config.ts";
import {
  ACTIVITY_DELETE_ANALYTICS_QUEUE,
  type ActivityAnalyticsJobData,
  EXPORT_QUEUE,
  type ExportJobData,
  FIT_FILE_IMPORT_BATCH_QUEUE,
  FIT_FILE_IMPORT_QUEUE,
  type FitFileImportBatchJobData,
  type FitFileImportJobData,
  type getRedisConnection,
  IMPORT_QUEUE,
  type ImportJobData,
  POST_SYNC_QUEUE,
  type PostSyncJobData,
  PROVIDER_DATA_DELETION_QUEUE,
  type ProviderDataDeletionJobData,
  providerDataDeletionJobDataSchema,
  providerSyncQueueName,
  SCHEDULED_SYNC_QUEUE,
  type ScheduledSyncJobData,
  SYNC_QUEUE,
  type SyncJobData,
  ZIP_ENTRY_EXTRACT_QUEUE,
  type ZipEntryExtractJobData,
} from "./queues.ts";

export function createWorkerQueues({
  db,
  connection,
  accountErasureWorkLockPool,
  getImportUploadStorage,
  getClickHouseClient,
  getRefitSensorStore,
  refreshPostSyncBodyMeasurements,
  accountErasureLeaseOwner,
  accountErasureRuntime,
  onSyncWaitingChildren,
}: {
  onSyncWaitingChildren: (worker: Worker, job: Job<SyncJobData>) => void;
  db: ReturnType<typeof createDatabaseFromEnv>;
  connection: ReturnType<typeof getRedisConnection>;
  accountErasureWorkLockPool: ReturnType<typeof createAccountErasureWorkLockPoolFromEnv>;
  getImportUploadStorage: () => ReturnType<typeof createImportUploadStorageFromEnv>;
  getClickHouseClient: () => ReturnType<typeof createClickHouseClientFromEnv>;
  getRefitSensorStore: () => ReturnType<typeof createRefitSensorStore>;
  refreshPostSyncBodyMeasurements: () => Promise<void>;
  accountErasureLeaseOwner: string;
  accountErasureRuntime: Awaited<ReturnType<typeof createAccountErasureRuntime>>;
}) {
  // ── Per-provider sync workers ──

  const providerWorkers = new Map<string, Worker<SyncJobData>>();

  for (const providerId of getConfiguredProviderIds()) {
    const config = getProviderQueueConfig(providerId);
    const worker = new Worker<SyncJobData>(
      providerSyncQueueName(providerId),
      (job, _token, signal) =>
        jobContext.run(job, () =>
          runQueuedUserWorkUnlessAccountErasing(
            accountErasureWorkLockPool,
            db,
            job.data.userId,
            "provider sync",
            () => processSyncJob(job, db, signal),
          ),
        ),
      {
        autorun: false,
        connection,
        concurrency: config.concurrency,
        ...(config.limiter ? { limiter: config.limiter } : {}),
      },
    );
    providerWorkers.set(providerId, worker);
  }

  logger.info(`[worker] Created ${providerWorkers.size} per-provider sync workers`);

  // ── Shared sync worker (CLI queue) ──

  const sharedSyncWorker = new Worker<SyncJobData>(
    SYNC_QUEUE,
    (job, _token, signal) =>
      jobContext.run(job, () =>
        runQueuedUserWorkUnlessAccountErasing(
          accountErasureWorkLockPool,
          db,
          job.data.userId,
          "CLI provider sync",
          async () => {
            try {
              await processSyncJob(job, db, signal);
            } catch (error) {
              if (error instanceof WaitingChildrenError) {
                onSyncWaitingChildren(sharedSyncWorker, job);
              }
              throw error;
            }
          },
        ),
      ),
    { autorun: false, connection },
  );

  // ── Other workers ──

  const importWorker: Worker<ImportJobData> = new Worker<ImportJobData>(
    IMPORT_QUEUE,
    (job, token) =>
      jobContext.run(job, () =>
        runQueuedUserWorkUnlessAccountErasing(
          accountErasureWorkLockPool,
          db,
          job.data.userId,
          "file import",
          () =>
            processFileUploadImportJob(
              importJobWithLockExtender(job, token, importWorker),
              db,
              getImportUploadStorage(),
            ),
        ),
      ),
    { autorun: false, connection },
  );
  const exportWorker = new Worker<ExportJobData>(
    EXPORT_QUEUE,
    (job) =>
      jobContext.run(job, () =>
        runQueuedUserWorkUnlessAccountErasing(
          accountErasureWorkLockPool,
          db,
          job.data.userId,
          "data export",
          () => processExportJob(job, db),
        ),
      ),
    { autorun: false, connection },
  );
  const fitFileImportWorker = new Worker<FitFileImportJobData>(
    FIT_FILE_IMPORT_QUEUE,
    (job) =>
      jobContext.run(job, () =>
        runQueuedUserWorkUnlessAccountErasing(
          accountErasureWorkLockPool,
          db,
          job.data.userId,
          "FIT file import",
          () => processFitFileImportJob(job, db),
        ),
      ),
    { autorun: false, connection, concurrency: 2 },
  );
  const fitFileImportBatchWorker = new Worker<FitFileImportBatchJobData>(
    FIT_FILE_IMPORT_BATCH_QUEUE,
    (job) =>
      jobContext.run(job, () =>
        runQueuedUserWorkUnlessAccountErasing(
          accountErasureWorkLockPool,
          db,
          job.data.userId,
          "FIT file import batch",
          () => processFitFileImportBatchJob(job),
        ),
      ),
    { autorun: false, connection, concurrency: 1 },
  );
  const zipEntryExtractWorker = new Worker<ZipEntryExtractJobData>(
    ZIP_ENTRY_EXTRACT_QUEUE,
    (job) =>
      jobContext.run(job, () =>
        runQueuedUserWorkUnlessAccountErasing(
          accountErasureWorkLockPool,
          db,
          job.data.userId,
          "ZIP entry extraction",
          () => processZipEntryExtractJob(job),
        ),
      ),
    { autorun: false, connection, concurrency: 2 },
  );
  const scheduledSyncWorker = new Worker<ScheduledSyncJobData>(
    SCHEDULED_SYNC_QUEUE,
    (job) => jobContext.run(job, () => processScheduledSyncJob(job, db)),
    { autorun: false, connection },
  );
  const postSyncWorker = new Worker<PostSyncJobData>(
    POST_SYNC_QUEUE,
    (job) =>
      jobContext.run(job, () =>
        job.data.type === "global-maintenance"
          ? processPostSyncJob(job, db, getRefitSensorStore, refreshPostSyncBodyMeasurements)
          : runQueuedUserWorkUnlessAccountErasing(
              accountErasureWorkLockPool,
              db,
              job.data.userId,
              "post-sync refit",
              () =>
                processPostSyncJob(job, db, getRefitSensorStore, refreshPostSyncBodyMeasurements),
            ),
      ),
    { autorun: false, connection, concurrency: 1 },
  );
  const activityDeleteAnalyticsWorker = new Worker<ActivityAnalyticsJobData>(
    ACTIVITY_DELETE_ANALYTICS_QUEUE,
    (job) =>
      jobContext.run(job, () =>
        runQueuedUserWorkUnlessAccountErasing(
          accountErasureWorkLockPool,
          db,
          job.data.userId,
          "activity analytics refresh",
          () => processActivityDeleteAnalyticsJob(job, db),
        ),
      ),
    { autorun: false, connection, concurrency: 1 },
  );
  const providerDataDeletionWorker = new Worker<ProviderDataDeletionJobData>(
    PROVIDER_DATA_DELETION_QUEUE,
    (job) => {
      try {
        job.data = providerDataDeletionJobDataSchema.parse(job.data);
      } catch (error) {
        throw new UnrecoverableError(error instanceof Error ? error.message : String(error));
      }
      return jobContext.run(job, () =>
        runQueuedUserWorkUnlessAccountErasing(
          accountErasureWorkLockPool,
          db,
          job.data.userId,
          "provider data deletion",
          () =>
            processProviderDataDeletionJob(
              job,
              createProviderDataDeletionDependencies(db, getClickHouseClient(), (workKind) =>
                accountErasureAllowsQueuedUserWork(db, job.data.userId, workKind),
              ),
            ),
        ),
      );
    },
    { autorun: false, connection, concurrency: 1 },
  );
  const accountErasureWorker = createAccountErasureWorker(
    db,
    accountErasureLeaseOwner,
    accountErasureRuntime.phaseRunner,
    { connection },
  );

  const allWorkers: Worker[] = [
    ...providerWorkers.values(),
    sharedSyncWorker,
    importWorker,
    exportWorker,
    fitFileImportWorker,
    fitFileImportBatchWorker,
    zipEntryExtractWorker,
    scheduledSyncWorker,
    postSyncWorker,
    activityDeleteAnalyticsWorker,
    providerDataDeletionWorker,
    accountErasureWorker,
  ];
  return { allWorkers, fitFileImportWorker, providerDataDeletionWorker };
}
function importJobWithLockExtender(
  job: Job<ImportJobData>,
  token: string | undefined,
  worker: Worker<ImportJobData>,
) {
  const jobId = job.id;
  if (!jobId) {
    throw new Error("BullMQ import job ID missing");
  }

  const requireToken = (): string => {
    if (!token) {
      throw new Error("BullMQ import job lock token missing");
    }
    return token;
  };

  return {
    id: jobId,
    queueQualifiedName: job.queueQualifiedName,
    data: job.data,
    updateProgress: (data: object) => job.updateProgress(data),
    updateData: (data: ImportJobData) => job.updateData(data),
    moveToWaitingChildren: () => job.moveToWaitingChildren(requireToken()),
    getChildrenValues: () => job.getChildrenValues<unknown>(),
    getIgnoredChildrenFailures: () => job.getIgnoredChildrenFailures(),
    log: async (message: string) => {
      await Job.addJobLog(worker, jobId, message, 500);
    },
    extendLock: async (durationMs: number) => {
      const extendedLockCount = await job.extendLock(requireToken(), durationMs);
      if (extendedLockCount !== 1) {
        throw new Error(`BullMQ import job lock is no longer owned: ${jobId}`);
      }
    },
  };
}
