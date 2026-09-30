import { randomUUID } from "node:crypto";
import { RedisConnection } from "bullmq";
import { afterAll, beforeAll, expect, it } from "vitest";
import type {} from "../bullmq-redis-client.ts";
import { getRedisConnection } from "../jobs/queues.ts";
import { RedisCacheStore } from "./cache.ts";

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

it("removes exactly one Redis payload and registration while preserving neighboring and other-user keys", async () => {
  const user = randomUUID();
  const target = `${user}:activity.stream:UTC:undefined`;
  const targetRedisKey = `query-cache:data:${target}`;
  const keys = [
    target,
    `${user}:activity.stream:UTC:undefined:adjacent`,
    `${randomUUID()}:activity.stream:UTC:undefined`,
  ];
  const redisKeys = keys.map((key) => `query-cache:data:${key}`);
  const client = await connection.client;
  const store = new RedisCacheStore(async () => ({
    get: (key) => client.get(key),
    set: (key, value, mode, ttl) => client.set(key, value, mode, ttl),
    del: (...keys) => client.del(...keys),
    sadd: (key, ...members) => client.sadd(key, ...members),
    smembers: (key) => client.smembers(key),
    srem: (key, ...members) => client.srem(key, ...members),
  }));
  try {
    for (const key of keys) await store.set(key, { value: key }, 60000);
    await store.invalidate(target);
    await expect(client.get(targetRedisKey)).resolves.toBeNull();
    const registered = await client.smembers("query-cache:keys");
    expect(registered).not.toContain(targetRedisKey);
    for (const key of redisKeys.slice(1)) {
      await expect(client.get(key)).resolves.not.toBeNull();
      expect(registered).toContain(key);
    }
  } finally {
    await client.del(...redisKeys);
    await client.srem("query-cache:keys", ...redisKeys);
  }
});
