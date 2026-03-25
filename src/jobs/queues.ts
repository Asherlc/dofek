import type { ConnectionOptions } from "bullmq";
import { Queue } from "bullmq";
import type { ProviderSyncTier } from "./provider-queue-config.ts";

// ── Job payload types ──

export interface SyncJobData {
  providerId?: string;
  sinceDays?: number;
  userId: string;
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

export interface PostSyncJobData {
  userId: string;
}

// ── Queue names ──

export const SYNC_QUEUE = "sync";
export const SYNC_QUEUE_PREFIX = "sync";
export const IMPORT_QUEUE = "import";
export const EXPORT_QUEUE = "export";
export const SCHEDULED_SYNC_QUEUE = "scheduled-sync";
export const POST_SYNC_QUEUE = "post-sync";

/** Get the per-provider queue name for a given provider ID. */
export function providerSyncQueueName(providerId: string): string {
  return `${SYNC_QUEUE_PREFIX}:${providerId}`;
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
