import type { ConnectionOptions, JobsOptions } from "bullmq";
import { Queue } from "bullmq";
import type { ProviderSyncTier } from "./provider-queue-config.ts";

// ── Job payload types ──

export interface SyncJobData {
  providerId?: string;
  sinceDays?: number;
  sinceIso?: string;
  userId: string;
  checkpoint?: unknown;
}

export interface ImportJobData {
  filePath: string;
  since: string; // ISO date string
  userId: string;
  importType: "apple-health" | "strong-csv" | "cronometer-csv";
  /** Weight unit for Strong CSV imports */
  weightUnit?: "kg" | "lbs";
}

export interface ExportJobData {
  exportId: string;
  userId: string;
  /** Full path to the output ZIP file in the shared job-files directory */
  outputPath: string;
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

export interface TrainingExportJobData {
  /** Optional: only export data after this timestamp */
  since?: string;
  /** Optional: only export data before this timestamp */
  until?: string;
}

// ── Queue names ──

export const SYNC_QUEUE = "sync";
export const SYNC_QUEUE_PREFIX = "sync";
export const IMPORT_QUEUE = "import";
export const EXPORT_QUEUE = "export";
export const SCHEDULED_SYNC_QUEUE = "scheduled-sync";
export const POST_SYNC_QUEUE = "post-sync";
export const TRAINING_EXPORT_QUEUE = "training-export";
export const POST_SYNC_DEBOUNCE_MS = 10_000;
export const SYNC_JOB_RETRY_OPTIONS = {
  attempts: 288,
  backoff: { type: "fixed", delay: 300_000 },
  removeOnComplete: { age: 86_400, count: 1_000 },
  removeOnFail: { age: 604_800, count: 1_000 },
} satisfies JobsOptions;

const GLOBAL_POST_SYNC_JOB_NAME = "global-maintenance";
const USER_REFIT_POST_SYNC_JOB_NAME = "user-refit";
const GLOBAL_POST_SYNC_DEDUPLICATION_ID = "post-sync:global-maintenance";

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

// ── Queue factories ──

/** @deprecated Use createProviderSyncQueue() for new code. Kept for legacy queue drain. */
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

export function createExportQueue(connection?: ConnectionOptions): Queue<ExportJobData> {
  return new Queue(EXPORT_QUEUE, { connection: connection ?? getRedisConnection() });
}

export function createScheduledSyncQueue(
  connection?: ConnectionOptions,
): Queue<ScheduledSyncJobData> {
  return new Queue(SCHEDULED_SYNC_QUEUE, { connection: connection ?? getRedisConnection() });
}

export function createPostSyncQueue(connection?: ConnectionOptions): Queue<PostSyncJobData> {
  return new Queue(POST_SYNC_QUEUE, { connection: connection ?? getRedisConnection() });
}

let cachedPostSyncQueue: Queue<PostSyncJobData> | null = null;

export function getPostSyncQueue(): Queue<PostSyncJobData> {
  if (!cachedPostSyncQueue) {
    cachedPostSyncQueue = createPostSyncQueue();
  }
  return cachedPostSyncQueue;
}

export async function enqueueDebouncedPostSyncMaintenance(
  queue: Queue<PostSyncJobData> = getPostSyncQueue(),
): Promise<void> {
  await queue.add(
    GLOBAL_POST_SYNC_JOB_NAME,
    { type: "global-maintenance" },
    {
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

export function createTrainingExportQueue(
  connection?: ConnectionOptions,
): Queue<TrainingExportJobData> {
  return new Queue(TRAINING_EXPORT_QUEUE, { connection: connection ?? getRedisConnection() });
}
