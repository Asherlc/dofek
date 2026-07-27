import { randomUUID } from "node:crypto";
import { RedisConnection } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {} from "../bullmq-redis-client.ts";
import { getRedisConnection } from "../jobs/queues.ts";
import { type AccountRedisClient, purgeAccountRedisState } from "./redis-erasure.ts";

describe("account Redis erasure", () => {
  let connection: RedisConnection;

  beforeAll(() => {
    connection = new RedisConnection(getRedisConnection(), {
      blocking: false,
      shared: false,
      skipVersionCheck: true,
    });
  });

  afterAll(async () => {
    await connection.close();
  });

  it("physically deletes attributable state and persists the mutation in Redis", async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const userCacheKey = `query-cache:data:${userId}:integration:{}`;
    const otherCacheKey = `query-cache:data:${otherUserId}:integration:{}`;
    const oauthKey = `oauth-state:account-erasure-${randomUUID()}`;
    const otherOauthKey = `oauth-state:account-erasure-${randomUUID()}`;
    const rateKey = `provider-rate-limit:garmin:user:${userId}`;
    const streamKey = `bull:account-erasure-test-${randomUUID()}:events`;
    const erasedJobId = `job-${randomUUID()}`;
    const otherJobId = `job-${randomUUID()}`;
    const client = await connection.client;
    const seededKeys = [userCacheKey, otherCacheKey, oauthKey, otherOauthKey, rateKey, streamKey];

    try {
      await client.set(userCacheKey, JSON.stringify({ isPrivate: true }));
      await client.set(otherCacheKey, JSON.stringify({ isPrivate: false }));
      await client.sadd("query-cache:keys", userCacheKey, otherCacheKey);
      await client.set(
        oauthKey,
        JSON.stringify({
          providerId: "wahoo",
          intent: "data",
          userId,
        }),
      );
      await client.set(
        otherOauthKey,
        JSON.stringify({
          providerId: "wahoo",
          intent: "data",
          userId: otherUserId,
        }),
      );
      await client.set(rateKey, "{}");
      await client.xadd(streamKey, "*", {
        event: "waiting",
        jobId: erasedJobId,
      });
      await client.xadd(streamKey, "*", {
        event: "waiting",
        jobId: otherJobId,
      });

      const result = await purgeAccountRedisState(
        {
          authIdentities: [],
          bullmqJobIds: [erasedJobId],
          sessionIds: [],
          uploadIds: [],
          userId,
        },
        client,
      );

      expect(result.deletedKeys).toBe(3);
      expect(result.deletedStreamEntries).toBe(1);
      expect(result.removedSetMembers).toBe(1);
      expect(result.rdbPersisted).toBe(true);
      await expect(client.get(userCacheKey)).resolves.toBeNull();
      await expect(client.get(oauthKey)).resolves.toBeNull();
      await expect(client.get(rateKey)).resolves.toBeNull();
      await expect(client.get(otherCacheKey)).resolves.not.toBeNull();
      await expect(client.get(otherOauthKey)).resolves.not.toBeNull();
      const retainedEvents = await client.xrange(streamKey, "-", "+", "COUNT", 100);
      expect(retainedEvents).toHaveLength(1);
      expect(retainedEvents[0]?.[1]).toContain(otherJobId);
      await expect(client.smembers("query-cache:keys")).resolves.not.toContain(userCacheKey);
    } finally {
      await client.del(...seededKeys);
      await client.srem("query-cache:keys", userCacheKey, otherCacheKey);
    }
  });

  it("persists a deletion when retrying after a crash before the durability barrier", async () => {
    const userId = randomUUID();
    const rateKey = `provider-rate-limit:garmin:user:${userId}`;
    const client = await connection.client;
    let crashBeforePersistence = true;
    const crashClient: AccountRedisClient = {
      bgrewriteaof: () => client.bgrewriteaof(),
      bgsave: (schedule) => client.bgsave(schedule),
      del: (...keys) => client.del(...keys),
      get: (key) => client.get(key),
      info: async (section) => {
        if (crashBeforePersistence && (await client.get(rateKey)) === null) {
          crashBeforePersistence = false;
          throw new Error("simulated process crash before Redis persistence");
        }
        return client.info(section);
      },
      scan: (cursor, matchKeyword, pattern, countKeyword, count) =>
        client.scan(cursor, matchKeyword, pattern, countKeyword, count),
      smembers: (key) => client.smembers(key),
      srem: (key, ...members) => client.srem(key, ...members),
      type: (key) => client.type(key),
      xdel: (key, ...ids) => client.xdel(key, ...ids),
      xrange: (key, start, end, countKeyword, count) =>
        client.xrange(key, start, end, countKeyword, count),
    };
    const identifiers = {
      authIdentities: [],
      bullmqJobIds: [],
      sessionIds: [],
      uploadIds: [],
      userId,
    };

    try {
      await client.set(rateKey, "{}");

      await expect(purgeAccountRedisState(identifiers, crashClient)).rejects.toThrow(
        "simulated process crash before Redis persistence",
      );
      await expect(client.get(rateKey)).resolves.toBeNull();

      const retryResult = await purgeAccountRedisState(identifiers, client);

      expect(retryResult.deletedKeys).toBe(0);
      expect(retryResult.rdbPersisted).toBe(true);
    } finally {
      await client.del(rateKey);
    }
  });
});
