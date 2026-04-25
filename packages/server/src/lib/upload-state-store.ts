import { RedisConnection } from "bullmq";
import { getRedisConnection } from "dofek/jobs/queues";
import { z } from "zod";

export const UPLOAD_SESSION_TTL_MS = 30 * 60 * 1000;
export const UPLOAD_STATUS_TTL_MS = 10 * 60 * 1000;

const uploadSessionSchema = z.object({
  total: z.number().int().positive(),
  dir: z.string(),
  userId: z.string(),
});

export type UploadSession = z.infer<typeof uploadSessionSchema>;

const uploadStatusSchema = z.object({
  status: z.enum(["uploading", "assembling", "processing", "done", "error"]),
  progress: z.number(),
  message: z.string(),
  userId: z.string(),
  expiresAt: z.number().optional(),
});

export type UploadStatus = z.infer<typeof uploadStatusSchema>;

interface RedisClient {
  set(key: string, value: string, mode: "PX", millisecondsToExpire: number): Promise<"OK" | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  scard(key: string): Promise<number>;
  smembers(key: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<number>;
}

export interface UploadStateStore {
  saveUploadSession(uploadId: string, session: UploadSession, timeToLiveMs?: number): Promise<void>;
  getUploadSession(uploadId: string): Promise<UploadSession | null>;
  deleteUploadSession(uploadId: string): Promise<void>;
  addReceivedChunk(uploadId: string, chunkIndex: number, timeToLiveMs?: number): Promise<number>;
  getReceivedChunkCount(uploadId: string): Promise<number>;
  getReceivedChunks(uploadId: string): Promise<number[]>;
  saveUploadStatus(uploadId: string, status: UploadStatus, timeToLiveMs?: number): Promise<void>;
  getUploadStatus(uploadId: string): Promise<UploadStatus | null>;
  deleteUploadStatus(uploadId: string): Promise<void>;
}

function uploadSessionKey(uploadId: string): string {
  return `upload-session:${uploadId}`;
}

function uploadChunksKey(uploadId: string): string {
  return `upload-chunks:${uploadId}`;
}

function uploadStatusKey(uploadId: string): string {
  return `upload-status:${uploadId}`;
}

function ttlSeconds(timeToLiveMs: number): number {
  return Math.max(1, Math.ceil(timeToLiveMs / 1000));
}

export class InMemoryUploadStateStore implements UploadStateStore {
  #sessions = new Map<string, { value: UploadSession; expiresAt: number }>();
  #chunkSets = new Map<string, { value: Set<number>; expiresAt: number }>();
  #statuses = new Map<string, { value: UploadStatus; expiresAt: number }>();

  async saveUploadSession(
    uploadId: string,
    session: UploadSession,
    timeToLiveMs = UPLOAD_SESSION_TTL_MS,
  ): Promise<void> {
    this.#sessions.set(uploadId, { value: session, expiresAt: Date.now() + timeToLiveMs });
  }

  async getUploadSession(uploadId: string): Promise<UploadSession | null> {
    return this.#getFresh(this.#sessions, uploadId)?.value ?? null;
  }

  async deleteUploadSession(uploadId: string): Promise<void> {
    this.#sessions.delete(uploadId);
    this.#chunkSets.delete(uploadId);
  }

  async addReceivedChunk(
    uploadId: string,
    chunkIndex: number,
    timeToLiveMs = UPLOAD_SESSION_TTL_MS,
  ): Promise<number> {
    const existing = this.#getFresh(this.#chunkSets, uploadId);
    const next = existing?.value ?? new Set<number>();
    next.add(chunkIndex);
    this.#chunkSets.set(uploadId, { value: next, expiresAt: Date.now() + timeToLiveMs });
    return next.size;
  }

  async getReceivedChunkCount(uploadId: string): Promise<number> {
    return this.#getFresh(this.#chunkSets, uploadId)?.value.size ?? 0;
  }

  async getReceivedChunks(uploadId: string): Promise<number[]> {
    const chunkSet = this.#getFresh(this.#chunkSets, uploadId)?.value ?? new Set<number>();
    return [...chunkSet].sort((left, right) => left - right);
  }

  async saveUploadStatus(
    uploadId: string,
    status: UploadStatus,
    timeToLiveMs = UPLOAD_STATUS_TTL_MS,
  ): Promise<void> {
    this.#statuses.set(uploadId, { value: status, expiresAt: Date.now() + timeToLiveMs });
  }

  async getUploadStatus(uploadId: string): Promise<UploadStatus | null> {
    return this.#getFresh(this.#statuses, uploadId)?.value ?? null;
  }

  async deleteUploadStatus(uploadId: string): Promise<void> {
    this.#statuses.delete(uploadId);
  }

  #getFresh<T>(
    store: Map<string, { value: T; expiresAt: number }>,
    key: string,
  ): { value: T; expiresAt: number } | null {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }
    return entry;
  }
}

export class RedisUploadStateStore implements UploadStateStore {
  readonly #getRedisClient: () => Promise<RedisClient>;

  constructor(getRedisClient: () => Promise<RedisClient> = getSharedRedisClient) {
    this.#getRedisClient = getRedisClient;
  }

  async saveUploadSession(
    uploadId: string,
    session: UploadSession,
    timeToLiveMs = UPLOAD_SESSION_TTL_MS,
  ): Promise<void> {
    const client = await this.#getRedisClient();
    await client.set(uploadSessionKey(uploadId), JSON.stringify(session), "PX", timeToLiveMs);
    await client.expire(uploadChunksKey(uploadId), ttlSeconds(timeToLiveMs));
  }

  async getUploadSession(uploadId: string): Promise<UploadSession | null> {
    const client = await this.#getRedisClient();
    const key = uploadSessionKey(uploadId);
    const payload = await client.get(key);
    if (!payload) return null;

    try {
      const parsed = uploadSessionSchema.safeParse(JSON.parse(payload));
      if (!parsed.success) {
        await client.del(key, uploadChunksKey(uploadId));
        return null;
      }
      return parsed.data;
    } catch {
      await client.del(key, uploadChunksKey(uploadId));
      return null;
    }
  }

  async deleteUploadSession(uploadId: string): Promise<void> {
    const client = await this.#getRedisClient();
    await client.del(uploadSessionKey(uploadId), uploadChunksKey(uploadId));
  }

  async addReceivedChunk(
    uploadId: string,
    chunkIndex: number,
    timeToLiveMs = UPLOAD_SESSION_TTL_MS,
  ): Promise<number> {
    const client = await this.#getRedisClient();
    const key = uploadChunksKey(uploadId);
    await client.sadd(key, String(chunkIndex));
    await client.expire(key, ttlSeconds(timeToLiveMs));
    return client.scard(key);
  }

  async getReceivedChunkCount(uploadId: string): Promise<number> {
    const client = await this.#getRedisClient();
    return client.scard(uploadChunksKey(uploadId));
  }

  async getReceivedChunks(uploadId: string): Promise<number[]> {
    const client = await this.#getRedisClient();
    const rawChunks = await client.smembers(uploadChunksKey(uploadId));
    return rawChunks
      .map((chunk) => Number.parseInt(chunk, 10))
      .filter((chunk) => Number.isFinite(chunk))
      .sort((left, right) => left - right);
  }

  async saveUploadStatus(
    uploadId: string,
    status: UploadStatus,
    timeToLiveMs = UPLOAD_STATUS_TTL_MS,
  ): Promise<void> {
    const client = await this.#getRedisClient();
    await client.set(uploadStatusKey(uploadId), JSON.stringify(status), "PX", timeToLiveMs);
  }

  async getUploadStatus(uploadId: string): Promise<UploadStatus | null> {
    const client = await this.#getRedisClient();
    const key = uploadStatusKey(uploadId);
    const payload = await client.get(key);
    if (!payload) return null;

    try {
      const parsed = uploadStatusSchema.safeParse(JSON.parse(payload));
      if (!parsed.success) {
        await client.del(key);
        return null;
      }
      return parsed.data;
    } catch {
      await client.del(key);
      return null;
    }
  }

  async deleteUploadStatus(uploadId: string): Promise<void> {
    const client = await this.#getRedisClient();
    await client.del(uploadStatusKey(uploadId));
  }
}

let sharedRedisConnection: RedisConnection | null = null;

async function getSharedRedisClient(): Promise<RedisClient> {
  if (!sharedRedisConnection) {
    sharedRedisConnection = new RedisConnection(getRedisConnection(), {
      shared: true,
      blocking: false,
      skipVersionCheck: true,
    });
  }
  const redisClient = await sharedRedisConnection.client;
  return {
    set: async (key, value, mode, millisecondsToExpire) =>
      redisClient.set(key, value, mode, millisecondsToExpire),
    get: async (key) => redisClient.get(key),
    del: async (...keys) => redisClient.del(...keys),
    sadd: async (key, ...members) => redisClient.sadd(key, ...members),
    scard: async (key) => redisClient.scard(key),
    smembers: async (key) => redisClient.smembers(key),
    expire: async (key, seconds) => redisClient.expire(key, seconds),
  };
}

const defaultUploadStateStore: UploadStateStore =
  process.env.NODE_ENV === "test" ? new InMemoryUploadStateStore() : new RedisUploadStateStore();

export function getUploadStateStore(): UploadStateStore {
  return defaultUploadStateStore;
}
