import { RedisConnection } from "bullmq";
import { getRedisConnection } from "dofek/jobs/queues";
import { z } from "zod";

const CHALLENGE_KEY_PREFIX = "whoop:verification:";
export const DEFAULT_CHALLENGE_TTL_MS = 10 * 60 * 1000;

export interface WhoopVerificationChallenge {
  session: string;
  method: string;
  username: string;
  expiresAt: number;
  userId: string;
}

interface RedisChallengeClient {
  set(key: string, value: string, mode: "PX", millisecondsToExpire: number): Promise<"OK" | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

const whoopVerificationChallengeSchema = z.object({
  session: z.string(),
  method: z.string(),
  username: z.string(),
  expiresAt: z.number(),
  userId: z.string(),
});

export interface WhoopVerificationChallengeStore {
  save(
    challengeId: string,
    challenge: WhoopVerificationChallenge,
    timeToLiveMs?: number,
  ): Promise<void>;
  get(challengeId: string): Promise<WhoopVerificationChallenge | null>;
  delete(challengeId: string): Promise<void>;
}

export class InMemoryWhoopVerificationChallengeStore implements WhoopVerificationChallengeStore {
  #challengeMap = new Map<string, { challenge: WhoopVerificationChallenge; expiresAt: number }>();

  async save(
    challengeId: string,
    challenge: WhoopVerificationChallenge,
    timeToLiveMs = DEFAULT_CHALLENGE_TTL_MS,
  ): Promise<void> {
    this.#challengeMap.set(challengeId, {
      challenge,
      expiresAt: Date.now() + timeToLiveMs,
    });
  }

  async get(challengeId: string): Promise<WhoopVerificationChallenge | null> {
    const challengeEntry = this.#challengeMap.get(challengeId);
    if (!challengeEntry) {
      return null;
    }

    if (challengeEntry.expiresAt <= Date.now()) {
      this.#challengeMap.delete(challengeId);
      return null;
    }

    return challengeEntry.challenge;
  }

  async delete(challengeId: string): Promise<void> {
    this.#challengeMap.delete(challengeId);
  }
}

export class RedisWhoopVerificationChallengeStore implements WhoopVerificationChallengeStore {
  readonly #getRedisClient: () => Promise<RedisChallengeClient>;

  constructor(getRedisClient: () => Promise<RedisChallengeClient> = getSharedRedisClient) {
    this.#getRedisClient = getRedisClient;
  }

  async save(
    challengeId: string,
    challenge: WhoopVerificationChallenge,
    timeToLiveMs = DEFAULT_CHALLENGE_TTL_MS,
  ): Promise<void> {
    const redisClient = await this.#getRedisClient();
    const challengeKey = getChallengeRedisKey(challengeId);
    await redisClient.set(challengeKey, JSON.stringify(challenge), "PX", timeToLiveMs);
  }

  async get(challengeId: string): Promise<WhoopVerificationChallenge | null> {
    const redisClient = await this.#getRedisClient();
    const challengeKey = getChallengeRedisKey(challengeId);
    const challengePayload = await redisClient.get(challengeKey);
    if (!challengePayload) {
      return null;
    }

    try {
      const parsedChallenge = whoopVerificationChallengeSchema.safeParse(
        JSON.parse(challengePayload),
      );
      if (!parsedChallenge.success) {
        await redisClient.del(challengeKey);
        return null;
      }

      return parsedChallenge.data;
    } catch {
      await redisClient.del(challengeKey);
      return null;
    }
  }

  async delete(challengeId: string): Promise<void> {
    const redisClient = await this.#getRedisClient();
    const challengeKey = getChallengeRedisKey(challengeId);
    await redisClient.del(challengeKey);
  }
}

function getChallengeRedisKey(challengeId: string): string {
  return `${CHALLENGE_KEY_PREFIX}${challengeId}`;
}

let sharedRedisConnection: RedisConnection | null = null;

async function getSharedRedisClient(): Promise<RedisChallengeClient> {
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
    del: async (key) => redisClient.del(key),
  };
}

const defaultChallengeStore: WhoopVerificationChallengeStore =
  process.env.NODE_ENV === "test"
    ? new InMemoryWhoopVerificationChallengeStore()
    : new RedisWhoopVerificationChallengeStore();

export function getWhoopVerificationChallengeStore(): WhoopVerificationChallengeStore {
  return defaultChallengeStore;
}
