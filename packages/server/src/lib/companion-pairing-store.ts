import { randomBytes } from "node:crypto";
import * as Sentry from "@sentry/node";
import { RedisConnection } from "bullmq";
import { getRedisConnection } from "dofek/jobs/queues";
import { z } from "zod";

export const COMPANION_PAIRING_TTL_MS = 10 * 60 * 1000;

const SHORT_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SHORT_CODE_LENGTH = 6;
const PAIRING_KEY_PREFIX = "companion-pairing:";
const PAIRING_CODE_KEY_PREFIX = "companion-pairing-code:";

const companionPairingChallengeSchema = z.object({
  id: z.string(),
  shortCode: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  claimedAt: z.string().optional(),
  userId: z.string().optional(),
  companionToken: z.string().optional(),
});

export type CompanionPairingChallenge = z.infer<typeof companionPairingChallengeSchema>;

interface RedisClient {
  set(key: string, value: string, options: { PX: number }): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
}

export interface CompanionPairingStore {
  createChallenge(now?: Date): Promise<CompanionPairingChallenge>;
  getById(id: string, now?: Date): Promise<CompanionPairingChallenge | null>;
  getByShortCode(shortCode: string, now?: Date): Promise<CompanionPairingChallenge | null>;
  claimChallenge(params: {
    shortCode: string;
    userId: string;
    companionToken: string;
    now?: Date;
  }): Promise<CompanionPairingChallenge | null>;
}

function pairingKey(id: string): string {
  return `${PAIRING_KEY_PREFIX}${id}`;
}

function pairingCodeKey(shortCode: string): string {
  return `${PAIRING_CODE_KEY_PREFIX}${shortCode}`;
}

function ttlMs(challenge: CompanionPairingChallenge, now = new Date()): number {
  return new Date(challenge.expiresAt).getTime() - now.getTime();
}

export function normalizePairingCode(code: string): string {
  return code.replace(/[\s-]/g, "").trim().toUpperCase();
}

export function generatePairingId(): string {
  return randomBytes(24).toString("base64url");
}

export function generateShortCode(): string {
  const bytes = randomBytes(SHORT_CODE_LENGTH);
  let code = "";
  for (const byte of bytes) {
    code += SHORT_CODE_ALPHABET[byte % SHORT_CODE_ALPHABET.length];
  }
  return code;
}

function newChallenge(now = new Date()): CompanionPairingChallenge {
  return {
    id: generatePairingId(),
    shortCode: generateShortCode(),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + COMPANION_PAIRING_TTL_MS).toISOString(),
  };
}

export class InMemoryCompanionPairingStore implements CompanionPairingStore {
  #byId = new Map<string, CompanionPairingChallenge>();
  #idByShortCode = new Map<string, string>();

  async createChallenge(now = new Date()): Promise<CompanionPairingChallenge> {
    let challenge = newChallenge(now);
    for (let attempt = 0; attempt < 5 && this.#idByShortCode.has(challenge.shortCode); attempt++) {
      challenge = newChallenge(now);
    }
    if (this.#idByShortCode.has(challenge.shortCode)) {
      throw new Error("Failed to allocate unique companion pairing code");
    }
    this.#save(challenge);
    return challenge;
  }

  async getById(id: string, now = new Date()): Promise<CompanionPairingChallenge | null> {
    const challenge = this.#byId.get(id);
    if (!challenge) return null;
    if (ttlMs(challenge, now) <= 0) {
      this.#delete(challenge);
      return null;
    }
    return challenge;
  }

  async getByShortCode(
    shortCode: string,
    now = new Date(),
  ): Promise<CompanionPairingChallenge | null> {
    const normalizedShortCode = normalizePairingCode(shortCode);
    const id = this.#idByShortCode.get(normalizedShortCode);
    if (!id) return null;
    return this.getById(id, now);
  }

  async claimChallenge({
    shortCode,
    userId,
    companionToken,
    now = new Date(),
  }: {
    shortCode: string;
    userId: string;
    companionToken: string;
    now?: Date;
  }): Promise<CompanionPairingChallenge | null> {
    const challenge = await this.getByShortCode(shortCode, now);
    if (!challenge || challenge.claimedAt) return null;
    const claimedChallenge = {
      ...challenge,
      claimedAt: now.toISOString(),
      userId,
      companionToken,
    };
    this.#save(claimedChallenge);
    return claimedChallenge;
  }

  #save(challenge: CompanionPairingChallenge): void {
    this.#byId.set(challenge.id, challenge);
    this.#idByShortCode.set(challenge.shortCode, challenge.id);
  }

  #delete(challenge: CompanionPairingChallenge): void {
    this.#byId.delete(challenge.id);
    this.#idByShortCode.delete(challenge.shortCode);
  }
}

export class RedisCompanionPairingStore implements CompanionPairingStore {
  readonly #getRedisClient: () => Promise<RedisClient>;

  constructor(getRedisClient: () => Promise<RedisClient> = getSharedRedisClient) {
    this.#getRedisClient = getRedisClient;
  }

  async createChallenge(now = new Date()): Promise<CompanionPairingChallenge> {
    let challenge = newChallenge(now);
    const client = await this.#getRedisClient();
    for (let attempt = 0; attempt < 5; attempt++) {
      const existingId = await client.get(pairingCodeKey(challenge.shortCode));
      if (!existingId) {
        await this.#save(challenge, now);
        return challenge;
      }
      challenge = newChallenge(now);
    }
    throw new Error("Failed to allocate unique companion pairing code");
  }

  async getById(id: string, now = new Date()): Promise<CompanionPairingChallenge | null> {
    const client = await this.#getRedisClient();
    const payload = await client.get(pairingKey(id));
    if (!payload) return null;

    try {
      const parsed = companionPairingChallengeSchema.safeParse(JSON.parse(payload));
      if (!parsed.success || ttlMs(parsed.data, now) <= 0) {
        await client.del(pairingKey(id));
        return null;
      }
      return parsed.data;
    } catch (error) {
      Sentry.captureException(error, { extra: { companionPairingId: id } });
      await client.del(pairingKey(id));
      return null;
    }
  }

  async getByShortCode(
    shortCode: string,
    now = new Date(),
  ): Promise<CompanionPairingChallenge | null> {
    const normalizedShortCode = normalizePairingCode(shortCode);
    const client = await this.#getRedisClient();
    const id = await client.get(pairingCodeKey(normalizedShortCode));
    if (!id) return null;
    return this.getById(id, now);
  }

  async claimChallenge({
    shortCode,
    userId,
    companionToken,
    now = new Date(),
  }: {
    shortCode: string;
    userId: string;
    companionToken: string;
    now?: Date;
  }): Promise<CompanionPairingChallenge | null> {
    const challenge = await this.getByShortCode(shortCode, now);
    if (!challenge || challenge.claimedAt) return null;
    const claimedChallenge = {
      ...challenge,
      claimedAt: now.toISOString(),
      userId,
      companionToken,
    };
    await this.#save(claimedChallenge, now);
    return claimedChallenge;
  }

  async #save(challenge: CompanionPairingChallenge, now = new Date()): Promise<void> {
    const client = await this.#getRedisClient();
    const remainingTtlMs = Math.max(1, ttlMs(challenge, now));
    await client.set(pairingKey(challenge.id), JSON.stringify(challenge), { PX: remainingTtlMs });
    await client.set(pairingCodeKey(challenge.shortCode), challenge.id, { PX: remainingTtlMs });
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
    set: async (key, value, options) => redisClient.set(key, value, options),
    get: async (key) => redisClient.get(key),
    del: async (...keys) => redisClient.del(...keys),
  };
}

const defaultCompanionPairingStore: CompanionPairingStore =
  process.env.NODE_ENV === "test"
    ? new InMemoryCompanionPairingStore()
    : new RedisCompanionPairingStore();

export function getCompanionPairingStore(): CompanionPairingStore {
  return defaultCompanionPairingStore;
}
