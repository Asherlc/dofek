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

// ── Queue names ──

export const SYNC_QUEUE = "sync";
export const IMPORT_QUEUE = "import";

// ── Shared Redis connection config ──

export function getRedisConnection(): ConnectionOptions {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || "6379", 10),
    password: parsed.password || undefined,
    maxRetriesPerRequest: 1,
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
