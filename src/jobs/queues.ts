import type { ConnectionOptions } from "bullmq";
import { Queue } from "bullmq";

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

// ── Queue names ──

export const SYNC_QUEUE = "sync";
export const IMPORT_QUEUE = "import";
export const EXPORT_QUEUE = "export";

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

export function createSyncQueue(connection?: ConnectionOptions): Queue<SyncJobData> {
  return new Queue(SYNC_QUEUE, { connection: connection ?? getRedisConnection() });
}

export function createImportQueue(connection?: ConnectionOptions): Queue<ImportJobData> {
  return new Queue(IMPORT_QUEUE, { connection: connection ?? getRedisConnection() });
}

export function createExportQueue(connection?: ConnectionOptions): Queue<ExportJobData> {
  return new Queue(EXPORT_QUEUE, { connection: connection ?? getRedisConnection() });
}
