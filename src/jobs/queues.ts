import { createHash } from "node:crypto";
import { ACTIVITY_MODALITIES, CANONICAL_ACTIVITY_TYPES } from "@dofek/training/activity-types";
import type { ConnectionOptions, JobsOptions } from "bullmq";
import { FlowProducer, Queue, QueueEvents, RedisConnection } from "bullmq";
import { z } from "zod";
import type {} from "../bullmq-redis-client.ts";
import type { DataExportRequest } from "../db/data-export.ts";
import type { ProviderDataDeletionRequest } from "../db/provider-data-deletion.ts";
import type { SyncLogOrigin } from "../db/schema/events.ts";
import type { ProviderSyncTier } from "./provider-queue-config.ts";

// ── Job payload types ──

export interface SyncJobData {
  /** Absent only on jobs enqueued before origin tracking; those logs remain unknown. */
  origin?: Exclude<SyncLogOrigin, "unknown">;
  providerId?: string;
  sinceDays?: number;
  sinceIso?: string;
  untilIso?: string;
  targetRefreshWindow?:
    | { type: "full" }
    | { type: "days"; days: number }
    | { type: "range"; sinceIso: string; untilIso: string };
  userId: string;
  checkpoint?: unknown;
  processingOperationIds?: Record<string, string>;
}

export interface ImportJobData {
  uploadId: string;
  userId: string;
  importType:
    | "apple-health"
    | "strong-csv"
    | "cronometer-csv"
    | "kaya-export"
    | "zos-app"
    | "garmin-dump"
    | "fit-file";
  checkpoint?: unknown;
}

export interface FileUploadImportQueue {
  add(name: string, data: ImportJobData, options?: JobsOptions): Promise<unknown>;
}

export const fitFileImportActivitySummarySchema = z.object({
  externalId: z.string(),
  activityType: z.object({
    canonicalType: z.enum(CANONICAL_ACTIVITY_TYPES),
    providerType: z.string().min(1),
    modality: z.enum(ACTIVITY_MODALITIES).nullable(),
  }),
  startedAtIso: z.string(),
  endedAtIso: z.string().optional(),
  name: z.string(),
  raw: z.unknown().optional(),
});

export const fitFileImportJobDataSchema = z.object({
  filePath: z.string().optional(),
  originalPath: z.string(),
  userId: z.string(),
  providerId: z.string(),
  sourceName: z.string(),
  activitySummary: fitFileImportActivitySummarySchema.optional(),
  deleteFileAfterImport: z.boolean().optional(),
});

export type FitFileImportActivitySummary = z.infer<typeof fitFileImportActivitySummarySchema>;
export type FitFileImportJobData = z.infer<typeof fitFileImportJobDataSchema>;

export const fitFileImportJobResultSchema = z.object({
  recordsSynced: z.number().int().nonnegative(),
  errors: z.array(z.object({ message: z.string() })),
});

export type FitFileImportJobResult = z.infer<typeof fitFileImportJobResultSchema>;

export const zipEntryExtractJobDataSchema = z.object({
  archivePath: z.string(),
  entryPath: z.array(z.string()).min(1),
  outputDirectory: z.string().optional(),
  outputExtension: z.string().regex(/^[A-Za-z0-9]+$/),
  maxBytes: z.number().int().positive().optional(),
  nestedArchiveMaxBytes: z.number().int().positive().optional(),
  userId: z.uuid(),
});

export type ZipEntryExtractJobData = z.infer<typeof zipEntryExtractJobDataSchema>;

export interface FitFileImportBatchJobData {
  type: "fit-file-import-batch";
  userId: string;
}

export interface ExportJobData {
  exportId: string;
  userId: string;
}

export interface DataExportQueue {
  add(name: string, data: ExportJobData, options?: JobsOptions): Promise<unknown>;
}

export interface ScheduledSyncJobData {
  /** Marker to distinguish from regular sync jobs */
  type: "scheduled-sync-all";
  /** Which sync tier this scheduled run targets (omit to sync all tiers) */
  syncTier?: ProviderSyncTier;
  /** Interval in ms between scheduled runs (used for stagger delay computation) */
  intervalMs?: number;
}

export interface GlobalMaintenancePostSyncJobData {
  type: "global-maintenance";
}

export interface UserRefitPostSyncJobData {
  type: "user-refit";
  userId: string;
}

export type PostSyncJobData = GlobalMaintenancePostSyncJobData | UserRefitPostSyncJobData;

export interface ActivityDeleteAnalyticsJobData {
  type: "activity-delete-analytics-refresh";
  userId: string;
  activityIds: string[];
}

export interface ActivityRestoreAnalyticsJobData {
  type: "activity-restore-analytics-refresh";
  userId: string;
  activityIds: string[];
}

export interface ActivityRecomputeAnalyticsJobData {
  type: "activity-recompute-analytics-refresh";
  userId: string;
  activityIds: string[];
}

export interface ProviderDeleteAnalyticsJobData {
  type: "provider-delete-analytics-refresh";
  userId: string;
  providerId: string;
  deletionEventId: string;
}

export const providerDataDeletionJobDataSchema = z.object({
  type: z.literal("provider-data-deletion"),
  eventId: z.uuid(),
  generation: z.number().int().positive(),
  providerId: z.string().min(1),
  userId: z.uuid(),
  checkpoint: z
    .object({
      batches: z.number().int().nonnegative(),
      deletedRows: z.number().int().nonnegative(),
      examinedRows: z.number().int().nonnegative().optional(),
      lastGeneration: z.number().int().nonnegative().default(0),
      lastId: z.uuid(),
    })
    .optional(),
});

export type ProviderDataDeletionJobData = z.infer<typeof providerDataDeletionJobDataSchema>;
export type ProviderDataDeletionContinuationJobData = ProviderDataDeletionJobData & {
  checkpoint: NonNullable<ProviderDataDeletionJobData["checkpoint"]>;
};

export interface ProviderDataDeletionQueue {
  add(name: string, data: ProviderDataDeletionJobData, options?: JobsOptions): Promise<unknown>;
}

export const accountErasureJobDataSchema = z
  .object({
    type: z.literal("account-erasure"),
    requestId: z.uuid(),
  })
  .strict();

export type AccountErasureJobData = z.infer<typeof accountErasureJobDataSchema>;

export interface AccountErasureQueue {
  add(name: string, data: AccountErasureJobData, options?: JobsOptions): Promise<unknown>;
}

export type ActivityAnalyticsJobData =
  | ActivityDeleteAnalyticsJobData
  | ActivityRestoreAnalyticsJobData
  | ActivityRecomputeAnalyticsJobData
  | ProviderDeleteAnalyticsJobData;

// ── Queue names ──

export const SYNC_QUEUE = "sync";
export const SYNC_QUEUE_PREFIX = "sync";
export const IMPORT_QUEUE = "import";
export const FIT_FILE_IMPORT_QUEUE = "fit-file-import";
export const FIT_FILE_IMPORT_BATCH_QUEUE = "fit-file-import-batch";
export const ZIP_ENTRY_EXTRACT_QUEUE = "zip-entry-extract";
export const EXPORT_QUEUE = "export";
export const SCHEDULED_SYNC_QUEUE = "scheduled-sync";
export const POST_SYNC_QUEUE = "post-sync";
export const PROVIDER_DATA_DELETION_QUEUE = "provider-data-deletion";
export const ACCOUNT_ERASURE_QUEUE = "account-erasure";
export const ACTIVITY_DELETE_ANALYTICS_QUEUE = "activity-delete-analytics";
export const POST_SYNC_DEBOUNCE_MS = 10_000;
export const SYNC_JOB_RETRY_OPTIONS = {
  attempts: 288,
  backoff: { type: "fixed", delay: 300_000 },
  removeOnComplete: { age: 86_400, count: 1_000 },
  removeOnFail: { age: 604_800, count: 1_000 },
} satisfies JobsOptions;

const GLOBAL_POST_SYNC_JOB_NAME = "global-maintenance";
const USER_REFIT_POST_SYNC_JOB_NAME = "user-refit";
const ACTIVITY_DELETE_ANALYTICS_JOB_NAME = "activity-delete-analytics-refresh";
const ACTIVITY_RESTORE_ANALYTICS_JOB_NAME = "activity-restore-analytics-refresh";
const ACTIVITY_RECOMPUTE_ANALYTICS_JOB_NAME = "activity-recompute-analytics-refresh";
const PROVIDER_DELETE_ANALYTICS_JOB_NAME = "provider-delete-analytics-refresh";
const PROVIDER_DATA_DELETION_JOB_NAME = "provider-data-deletion";
const ACCOUNT_ERASURE_JOB_NAME = "account-erasure";
const DATA_EXPORT_JOB_NAME = "export";
const GLOBAL_POST_SYNC_DEDUPLICATION_ID = "post-sync:global-maintenance";

function providerDataDeletionJobOptions(jobId: string): JobsOptions {
  return {
    attempts: 20,
    backoff: { type: "fixed", delay: 30_000 },
    jobId,
    removeOnComplete: { age: 604_800, count: 1_000 },
    removeOnFail: { age: 2_592_000, count: 1_000 },
  };
}

function activityRecomputeAnalyticsJobId(userId: string, activityIds: string[]): string {
  const activitySetHash = createHash("sha256")
    .update([...activityIds].sort().join("\n"))
    .digest("hex")
    .slice(0, 16);
  return `${ACTIVITY_RECOMPUTE_ANALYTICS_JOB_NAME}-${userId}-${activitySetHash}`;
}

/** Get the per-provider queue name for a given provider ID. */
export function providerSyncQueueName(providerId: string): string {
  return `${SYNC_QUEUE_PREFIX}-${providerId}`;
}

// ── Shared Redis connection config ──

export function getRedisConnection(): ConnectionOptions {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || "6379", 10),
    password: parsed.password || undefined,
    maxRetriesPerRequest: null,
    connectTimeout: 5000,
    lazyConnect: true,
  };
}

// ── Shared Redis connection ──

let sharedRedisConnection: RedisConnection | null = null;

/** Get the singleton RedisConnection shared across all modules in this process. */
export function getSharedRedisConnection(): RedisConnection {
  if (!sharedRedisConnection) {
    sharedRedisConnection = new RedisConnection(getRedisConnection(), {
      shared: true,
      blocking: false,
      skipVersionCheck: true,
    });
  }
  return sharedRedisConnection;
}

// ── Queue factories ──

/** Creates the shared sync queue used by the CLI and queue dashboard. */
export function createSyncQueue(connection?: ConnectionOptions): Queue<SyncJobData> {
  return new Queue(SYNC_QUEUE, { connection: connection ?? getRedisConnection() });
}

/** Create a per-provider sync queue (e.g., sync:strava, sync:garmin). */
export function createProviderSyncQueue(
  providerId: string,
  connection?: ConnectionOptions,
): Queue<SyncJobData> {
  return new Queue(providerSyncQueueName(providerId), {
    connection: connection ?? getRedisConnection(),
  });
}

/** Cache of per-provider queue instances to avoid creating new Redis connections. */
const cachedProviderQueues = new Map<string, Queue<SyncJobData>>();

/** Get or create a cached per-provider sync queue. Reuses the same Queue (and Redis connection) across calls. */
export function getProviderSyncQueue(providerId: string): Queue<SyncJobData> {
  let queue = cachedProviderQueues.get(providerId);
  if (!queue) {
    queue = createProviderSyncQueue(providerId);
    cachedProviderQueues.set(providerId, queue);
  }
  return queue;
}

export function createImportQueue(connection?: ConnectionOptions): Queue<ImportJobData> {
  return new Queue(IMPORT_QUEUE, { connection: connection ?? getRedisConnection() });
}

export async function enqueueFileUploadImport(
  request: import("../db/file-upload.ts").FileUploadOutboxRequest,
  queue: FileUploadImportQueue,
): Promise<void> {
  await queue.add(
    request.importType,
    {
      uploadId: request.uploadId,
      userId: request.userId,
      importType: request.importType,
    },
    { jobId: request.importJobId },
  );
}

export function createFitFileImportQueue(
  connection?: ConnectionOptions,
): Queue<FitFileImportJobData, FitFileImportJobResult> {
  return new Queue(FIT_FILE_IMPORT_QUEUE, { connection: connection ?? getRedisConnection() });
}

export function createFitFileImportBatchQueue(
  connection?: ConnectionOptions,
): Queue<FitFileImportBatchJobData> {
  return new Queue(FIT_FILE_IMPORT_BATCH_QUEUE, { connection: connection ?? getRedisConnection() });
}

export function createZipEntryExtractQueue(
  connection?: ConnectionOptions,
): Queue<ZipEntryExtractJobData> {
  return new Queue(ZIP_ENTRY_EXTRACT_QUEUE, { connection: connection ?? getRedisConnection() });
}

export function createFlowProducer(connection?: ConnectionOptions): FlowProducer {
  return new FlowProducer({ connection: connection ?? getRedisConnection() });
}

export function createExportQueue(connection?: ConnectionOptions): Queue<ExportJobData> {
  return new Queue(EXPORT_QUEUE, { connection: connection ?? getRedisConnection() });
}

export async function enqueueDataExport(
  request: DataExportRequest,
  queue: DataExportQueue = getDataExportQueue(),
): Promise<void> {
  await queue.add(
    DATA_EXPORT_JOB_NAME,
    { exportId: request.exportId, userId: request.userId },
    {
      jobId: request.exportId,
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
}

export function createScheduledSyncQueue(
  connection?: ConnectionOptions,
): Queue<ScheduledSyncJobData> {
  return new Queue(SCHEDULED_SYNC_QUEUE, { connection: connection ?? getRedisConnection() });
}

export function createPostSyncQueue(connection?: ConnectionOptions): Queue<PostSyncJobData> {
  return new Queue(POST_SYNC_QUEUE, { connection: connection ?? getRedisConnection() });
}

export function createActivityDeleteAnalyticsQueue(
  connection?: ConnectionOptions,
): Queue<ActivityAnalyticsJobData> {
  return new Queue(ACTIVITY_DELETE_ANALYTICS_QUEUE, {
    connection: connection ?? getRedisConnection(),
  });
}

export function createProviderDataDeletionQueue(
  connection?: ConnectionOptions,
): Queue<ProviderDataDeletionJobData> {
  return new Queue(PROVIDER_DATA_DELETION_QUEUE, {
    connection: connection ?? getRedisConnection(),
  });
}

export function createAccountErasureQueue(
  connection?: ConnectionOptions,
): Queue<AccountErasureJobData> {
  return new Queue(ACCOUNT_ERASURE_QUEUE, {
    connection: connection ?? getRedisConnection(),
  });
}

let cachedPostSyncQueue: Queue<PostSyncJobData> | null = null;
let cachedActivityDeleteAnalyticsQueue: Queue<ActivityAnalyticsJobData> | null = null;
let cachedProviderDataDeletionQueue: Queue<ProviderDataDeletionJobData> | null = null;
let cachedAccountErasureQueue: Queue<AccountErasureJobData> | null = null;
let cachedImportQueue: Queue<ImportJobData> | null = null;
let cachedDataExportQueue: Queue<ExportJobData> | null = null;
let cachedFitFileImportQueue: Queue<FitFileImportJobData, FitFileImportJobResult> | null = null;
let cachedFitFileImportQueueEvents: QueueEvents | null = null;
let cachedFlowProducer: FlowProducer | null = null;

export function getImportQueue(): Queue<ImportJobData> {
  if (!cachedImportQueue) {
    cachedImportQueue = createImportQueue();
  }
  return cachedImportQueue;
}

export function getDataExportQueue(): Queue<ExportJobData> {
  if (!cachedDataExportQueue) {
    cachedDataExportQueue = createExportQueue();
  }
  return cachedDataExportQueue;
}

export function getFitFileImportQueue(): Queue<FitFileImportJobData, FitFileImportJobResult> {
  if (!cachedFitFileImportQueue) {
    cachedFitFileImportQueue = createFitFileImportQueue();
  }
  return cachedFitFileImportQueue;
}

export function getFitFileImportQueueEvents(): QueueEvents {
  if (!cachedFitFileImportQueueEvents) {
    cachedFitFileImportQueueEvents = new QueueEvents(FIT_FILE_IMPORT_QUEUE, {
      connection: getRedisConnection(),
    });
  }
  return cachedFitFileImportQueueEvents;
}

export function getFlowProducer(): FlowProducer {
  if (!cachedFlowProducer) {
    cachedFlowProducer = createFlowProducer();
  }
  return cachedFlowProducer;
}

export async function closeFitFileImportQueueResources(): Promise<void> {
  const queue = cachedFitFileImportQueue;
  const flowProducer = cachedFlowProducer;

  const closeOperations: Array<Promise<unknown>> = [];
  if (queue) {
    closeOperations.push(queue.close());
  }
  if (cachedFitFileImportQueueEvents) {
    closeOperations.push(cachedFitFileImportQueueEvents.close());
  }
  if (flowProducer) {
    closeOperations.push(flowProducer.close());
  }
  await Promise.all(closeOperations);

  cachedFitFileImportQueue = null;
  cachedFitFileImportQueueEvents = null;
  cachedFlowProducer = null;
}

export function getPostSyncQueue(): Queue<PostSyncJobData> {
  if (!cachedPostSyncQueue) {
    cachedPostSyncQueue = createPostSyncQueue();
  }
  return cachedPostSyncQueue;
}

export function getActivityDeleteAnalyticsQueue(): Queue<ActivityAnalyticsJobData> {
  if (!cachedActivityDeleteAnalyticsQueue) {
    cachedActivityDeleteAnalyticsQueue = createActivityDeleteAnalyticsQueue();
  }
  return cachedActivityDeleteAnalyticsQueue;
}

export function getProviderDataDeletionQueue(): Queue<ProviderDataDeletionJobData> {
  if (!cachedProviderDataDeletionQueue) {
    cachedProviderDataDeletionQueue = createProviderDataDeletionQueue();
  }
  return cachedProviderDataDeletionQueue;
}

export function getAccountErasureQueue(): Queue<AccountErasureJobData> {
  cachedAccountErasureQueue ??= createAccountErasureQueue();
  return cachedAccountErasureQueue;
}

export async function enqueueAccountErasure(
  request: { id: string },
  queue: AccountErasureQueue = getAccountErasureQueue(),
): Promise<void> {
  await queue.add(
    ACCOUNT_ERASURE_JOB_NAME,
    {
      type: "account-erasure",
      requestId: request.id,
    },
    {
      attempts: 1,
      jobId: request.id,
      removeOnComplete: true,
      removeOnFail: true,
    },
  );
}

export async function enqueueProviderDataDeletion(
  request: ProviderDataDeletionRequest,
  queue: ProviderDataDeletionQueue = getProviderDataDeletionQueue(),
): Promise<void> {
  await queue.add(
    PROVIDER_DATA_DELETION_JOB_NAME,
    {
      type: "provider-data-deletion",
      eventId: request.eventId,
      generation: request.generation,
      providerId: request.providerId,
      userId: request.userId,
    },
    providerDataDeletionJobOptions(request.eventId),
  );
}

export async function enqueueProviderDataDeletionContinuation(
  data: ProviderDataDeletionContinuationJobData,
  queue: ProviderDataDeletionQueue = getProviderDataDeletionQueue(),
): Promise<void> {
  await queue.add(
    PROVIDER_DATA_DELETION_JOB_NAME,
    data,
    providerDataDeletionJobOptions(`${data.eventId}-batch-${data.checkpoint.batches}`),
  );
}

export async function enqueueActivityDeleteAnalyticsRefresh(
  userId: string,
  activityIds: string[],
  queue: Queue<ActivityAnalyticsJobData> = getActivityDeleteAnalyticsQueue(),
): Promise<void> {
  const uniqueActivityIds = [...new Set(activityIds)];
  if (uniqueActivityIds.length === 0) return;

  await queue.add(
    ACTIVITY_DELETE_ANALYTICS_JOB_NAME,
    {
      type: "activity-delete-analytics-refresh",
      userId,
      activityIds: uniqueActivityIds,
    },
    {
      removeOnComplete: true,
      removeOnFail: { age: 604_800, count: 100 },
      attempts: 5,
      backoff: { type: "fixed", delay: 30_000 },
    },
  );
}

export async function enqueueProviderDeleteAnalyticsRefresh(
  userId: string,
  providerId: string,
  deletionEventId: string,
  queue: Queue<ActivityAnalyticsJobData> = getActivityDeleteAnalyticsQueue(),
): Promise<void> {
  await queue.add(
    PROVIDER_DELETE_ANALYTICS_JOB_NAME,
    {
      type: "provider-delete-analytics-refresh",
      userId,
      providerId,
      deletionEventId,
    },
    {
      jobId: `${PROVIDER_DELETE_ANALYTICS_JOB_NAME}-${deletionEventId}`,
      removeOnComplete: { age: 604_800, count: 1_000 },
      removeOnFail: { age: 604_800, count: 100 },
      attempts: 5,
      backoff: { type: "fixed", delay: 30_000 },
    },
  );
}

export async function enqueueActivityRestoreAnalyticsRefresh(
  userId: string,
  activityIds: string[],
  queue: Queue<ActivityAnalyticsJobData> = getActivityDeleteAnalyticsQueue(),
): Promise<void> {
  const uniqueActivityIds = [...new Set(activityIds)];
  if (uniqueActivityIds.length === 0) return;

  await queue.add(
    ACTIVITY_RESTORE_ANALYTICS_JOB_NAME,
    {
      type: "activity-restore-analytics-refresh",
      userId,
      activityIds: uniqueActivityIds,
    },
    {
      removeOnComplete: true,
      removeOnFail: { age: 604_800, count: 100 },
      attempts: 5,
      backoff: { type: "fixed", delay: 30_000 },
    },
  );
}

export async function enqueueActivityRecomputeAnalyticsRefresh(
  userId: string,
  activityIds: string[],
  queue: Queue<ActivityAnalyticsJobData> = getActivityDeleteAnalyticsQueue(),
): Promise<void> {
  const uniqueActivityIds = [...new Set(activityIds)];
  if (uniqueActivityIds.length === 0) return;

  await queue.add(
    ACTIVITY_RECOMPUTE_ANALYTICS_JOB_NAME,
    {
      type: "activity-recompute-analytics-refresh",
      userId,
      activityIds: uniqueActivityIds,
    },
    {
      removeOnComplete: true,
      removeOnFail: { age: 604_800, count: 100 },
      attempts: 5,
      backoff: { type: "fixed", delay: 30_000 },
      jobId: activityRecomputeAnalyticsJobId(userId, uniqueActivityIds),
    },
  );
}

export async function enqueueDebouncedPostSyncMaintenance(
  queue: Queue<PostSyncJobData> = getPostSyncQueue(),
): Promise<void> {
  await queue.add(
    GLOBAL_POST_SYNC_JOB_NAME,
    { type: "global-maintenance" },
    {
      ...SYNC_JOB_RETRY_OPTIONS,
      delay: POST_SYNC_DEBOUNCE_MS,
      deduplication: {
        id: GLOBAL_POST_SYNC_DEDUPLICATION_ID,
        ttl: POST_SYNC_DEBOUNCE_MS,
        extend: true,
        replace: true,
      },
      removeOnComplete: true,
    },
  );
}

export async function enqueueDebouncedUserRefit(
  userId: string,
  queue: Queue<PostSyncJobData> = getPostSyncQueue(),
): Promise<void> {
  await queue.add(
    USER_REFIT_POST_SYNC_JOB_NAME,
    { type: "user-refit", userId },
    {
      ...SYNC_JOB_RETRY_OPTIONS,
      delay: POST_SYNC_DEBOUNCE_MS,
      deduplication: {
        id: `post-sync:user-refit:${userId}`,
        ttl: POST_SYNC_DEBOUNCE_MS,
        extend: true,
        replace: true,
      },
      removeOnComplete: true,
    },
  );
}

/** Close all cached queues, flow producers, and the shared Redis connection. */
export async function closeAllQueueResources(): Promise<void> {
  const closePromises: Array<Promise<unknown>> = [];

  for (const queue of cachedProviderQueues.values()) {
    closePromises.push(queue.close());
  }
  cachedProviderQueues.clear();

  if (cachedPostSyncQueue) closePromises.push(cachedPostSyncQueue.close());
  if (cachedActivityDeleteAnalyticsQueue)
    closePromises.push(cachedActivityDeleteAnalyticsQueue.close());
  if (cachedProviderDataDeletionQueue) closePromises.push(cachedProviderDataDeletionQueue.close());
  if (cachedAccountErasureQueue) closePromises.push(cachedAccountErasureQueue.close());
  if (cachedImportQueue) closePromises.push(cachedImportQueue.close());
  if (cachedDataExportQueue) closePromises.push(cachedDataExportQueue.close());
  if (cachedFitFileImportQueue) closePromises.push(cachedFitFileImportQueue.close());
  if (cachedFitFileImportQueueEvents) closePromises.push(cachedFitFileImportQueueEvents.close());
  if (cachedFlowProducer) closePromises.push(cachedFlowProducer.close());

  cachedPostSyncQueue = null;
  cachedActivityDeleteAnalyticsQueue = null;
  cachedProviderDataDeletionQueue = null;
  cachedAccountErasureQueue = null;
  cachedImportQueue = null;
  cachedDataExportQueue = null;
  cachedFitFileImportQueue = null;
  cachedFitFileImportQueueEvents = null;
  cachedFlowProducer = null;

  await Promise.allSettled(closePromises);

  if (sharedRedisConnection) {
    await sharedRedisConnection.close();
    sharedRedisConnection = null;
  }
}
