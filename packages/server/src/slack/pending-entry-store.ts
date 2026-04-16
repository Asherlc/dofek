import { randomUUID } from "node:crypto";
import { RedisConnection } from "bullmq";
import { getRedisConnection } from "dofek/jobs/queues";
import { z } from "zod";
import type { NutritionItemWithMeal } from "../lib/ai-nutrition.ts";

const PENDING_ENTRY_TTL_MS = 24 * 60 * 60 * 1000;
const ENTRY_KEY_PREFIX = "slack:pending-entry:";
const MESSAGE_INDEX_KEY_PREFIX = "slack:pending-message:";

const pendingEntrySchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  date: z.string(),
  item: z.custom<NutritionItemWithMeal>(),
  channelId: z.string(),
  confirmationMessageTs: z.string(),
  threadTs: z.string(),
  sourceMessageTs: z.string(),
  slackUserId: z.string(),
});

export type PendingSlackEntry = {
  id: string;
  userId: string;
  date: string;
  item: NutritionItemWithMeal;
  channelId: string;
  confirmationMessageTs: string;
  threadTs: string;
  sourceMessageTs: string;
  slackUserId: string;
};

interface RedisClient {
  set(key: string, value: string, mode: "PX", millisecondsToExpire: number): Promise<"OK" | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
}

export interface PendingEntryStore {
  save(entries: Omit<PendingSlackEntry, "id">[]): Promise<string[]>;
  loadByIds(ids: string[]): Promise<PendingSlackEntry[]>;
  deleteByIds(ids: string[]): Promise<void>;
  findIdsByMessage(channelId: string, confirmationMessageTs: string): Promise<string[]>;
}

class InMemoryPendingEntryStore implements PendingEntryStore {
  #entries = new Map<string, PendingSlackEntry>();
  #messageIndex = new Map<string, string[]>();

  async save(entries: Omit<PendingSlackEntry, "id">[]): Promise<string[]> {
    const ids = entries.map(() => randomUUID());
    for (let index = 0; index < entries.length; index++) {
      const id = ids[index];
      const entry = entries[index];
      if (!id || !entry) continue;
      this.#entries.set(id, { id, ...entry });
      const messageKey = `${entry.channelId}:${entry.confirmationMessageTs}`;
      const existing = this.#messageIndex.get(messageKey) ?? [];
      this.#messageIndex.set(messageKey, [...existing, id]);
    }
    return ids;
  }

  async loadByIds(ids: string[]): Promise<PendingSlackEntry[]> {
    return ids
      .map((id) => this.#entries.get(id))
      .filter((entry): entry is PendingSlackEntry => !!entry);
  }

  async deleteByIds(ids: string[]): Promise<void> {
    for (const id of ids) {
      const entry = this.#entries.get(id);
      if (!entry) continue;
      this.#entries.delete(id);
      const messageKey = `${entry.channelId}:${entry.confirmationMessageTs}`;
      const existing = this.#messageIndex.get(messageKey) ?? [];
      const next = existing.filter((existingId) => existingId !== id);
      if (next.length > 0) this.#messageIndex.set(messageKey, next);
      else this.#messageIndex.delete(messageKey);
    }
  }

  async findIdsByMessage(channelId: string, confirmationMessageTs: string): Promise<string[]> {
    return this.#messageIndex.get(`${channelId}:${confirmationMessageTs}`) ?? [];
  }
}

class RedisPendingEntryStore implements PendingEntryStore {
  readonly #getRedisClient: () => Promise<RedisClient>;

  constructor(getRedisClient: () => Promise<RedisClient> = getSharedRedisClient) {
    this.#getRedisClient = getRedisClient;
  }

  async save(entries: Omit<PendingSlackEntry, "id">[]): Promise<string[]> {
    const redisClient = await this.#getRedisClient();
    const ids: string[] = [];
    for (const entry of entries) {
      const id = randomUUID();
      ids.push(id);
      const payload: PendingSlackEntry = { id, ...entry };
      await redisClient.set(
        `${ENTRY_KEY_PREFIX}${id}`,
        JSON.stringify(payload),
        "PX",
        PENDING_ENTRY_TTL_MS,
      );
      const messageIndexKey = `${MESSAGE_INDEX_KEY_PREFIX}${entry.channelId}:${entry.confirmationMessageTs}`;
      const existingIndex = await redisClient.get(messageIndexKey);
      const currentIds = existingIndex ? parseStringArray(existingIndex) : [];
      currentIds.push(id);
      await redisClient.set(
        messageIndexKey,
        JSON.stringify(currentIds),
        "PX",
        PENDING_ENTRY_TTL_MS,
      );
    }
    return ids;
  }

  async loadByIds(ids: string[]): Promise<PendingSlackEntry[]> {
    const redisClient = await this.#getRedisClient();
    const entries: PendingSlackEntry[] = [];
    for (const id of ids) {
      const payload = await redisClient.get(`${ENTRY_KEY_PREFIX}${id}`);
      if (!payload) continue;
      const parsed = parsePendingEntry(payload);
      if (parsed) entries.push(parsed);
    }
    return entries;
  }

  async deleteByIds(ids: string[]): Promise<void> {
    const entries = await this.loadByIds(ids);
    const redisClient = await this.#getRedisClient();
    for (const entry of entries) {
      const messageIndexKey = `${MESSAGE_INDEX_KEY_PREFIX}${entry.channelId}:${entry.confirmationMessageTs}`;
      const existingIndex = await redisClient.get(messageIndexKey);
      const currentIds = existingIndex ? parseStringArray(existingIndex) : [];
      const nextIds = currentIds.filter((id) => id !== entry.id);
      if (nextIds.length > 0) {
        await redisClient.set(messageIndexKey, JSON.stringify(nextIds), "PX", PENDING_ENTRY_TTL_MS);
      } else {
        await redisClient.del(messageIndexKey);
      }
    }
    const keys = ids.map((id) => `${ENTRY_KEY_PREFIX}${id}`);
    if (keys.length > 0) {
      await redisClient.del(...keys);
    }
  }

  async findIdsByMessage(channelId: string, confirmationMessageTs: string): Promise<string[]> {
    const redisClient = await this.#getRedisClient();
    const messageIndexKey = `${MESSAGE_INDEX_KEY_PREFIX}${channelId}:${confirmationMessageTs}`;
    const payload = await redisClient.get(messageIndexKey);
    return payload ? parseStringArray(payload) : [];
  }
}

function parseStringArray(payload: string): string[] {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

function parsePendingEntry(payload: string): PendingSlackEntry | null {
  try {
    const parsed = pendingEntrySchema.safeParse(JSON.parse(payload));
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    return null;
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
  };
}

export function createPendingEntryStore(): PendingEntryStore {
  return process.env.NODE_ENV === "test"
    ? new InMemoryPendingEntryStore()
    : new RedisPendingEntryStore();
}
