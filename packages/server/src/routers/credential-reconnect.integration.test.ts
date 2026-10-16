import { randomUUID } from "node:crypto";
import { createConnection, createServer, type Socket } from "node:net";
import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { Worker } from "bullmq";
import { initiateAccountErasure, withAccountErasureUserWriteFence } from "dofek/db/account-erasure";
import { loadTokens, saveTokens } from "dofek/db/tokens";
import { scheduleDelayedSyncJob } from "dofek/jobs/enqueue-sync-job";
import { providerRateLimitCooldownStore } from "dofek/jobs/provider-rate-limit-cooldown";
import {
  closeAllQueueResources,
  getProviderSyncQueue,
  getRedisConnection,
  getSharedRedisConnection,
} from "dofek/jobs/queues";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { completeCredentialReconnect } from "./credential-reconnect.ts";

describe("credential reconnect persistence and dispatch", () => {
  let context: TestContext;
  const provider = { id: `reconnect-test-${randomUUID()}`, name: "Reconnect Test" };
  const userId = randomUUID();
  let cleanupRedisProxy: (() => Promise<void>) | undefined;
  const tokens = {
    accessToken: "renewed",
    refreshToken: null,
    expiresAt: new Date("2026-10-08"),
    scopes: null,
  };

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name) VALUES (${userId}::uuid, 'Reconnect User')`,
    );
  }, 120_000);

  afterAll(async () => {
    await getProviderSyncQueue(provider.id).obliterate({ force: true });
    await closeAllQueueResources();
    await context?.cleanup();
  });

  afterEach(async () => {
    await cleanupRedisProxy?.();
    cleanupRedisProxy = undefined;
  });

  it("commits renewed credentials and dispatches even while an older full sync is active", async () => {
    const queue = getProviderSyncQueue(provider.id);
    const old = await queue.add(
      "sync",
      { providerId: provider.id, userId, targetRefreshWindow: { type: "full" } },
      { deduplication: { id: `sync:full:${provider.id}:${userId}` } },
    );
    const worker = new Worker(queue.name, async () => undefined, {
      autorun: false,
      connection: getRedisConnection(),
    });
    try {
      const active = await worker.getNextJob("reconnect-test-lock");
      expect(active?.id).toBe(old.id);
      expect(await old.getState()).toBe("active");
      await completeCredentialReconnect({ db: context.db, userId }, provider, (transaction) =>
        saveTokens(transaction, provider.id, tokens, userId),
      );
      expect(await loadTokens(context.db, provider.id, userId)).toMatchObject(tokens);
      const waiting = await queue.getWaiting();
      expect(waiting).toHaveLength(1);
      expect(waiting[0]?.id).not.toBe(old.id);
      expect(waiting[0]?.data).toMatchObject({ userId, targetRefreshWindow: { type: "full" } });
    } finally {
      await worker.close();
    }
  });

  it("retains a fresh full reconnect request alongside a delayed bounded retry", async () => {
    const cooldown = await providerRateLimitCooldownStore.record(
      new ProviderRateLimitError({
        providerId: provider.id,
        statusCode: 429,
        message: "Cooldown",
        responseBody: "rate limited",
      }),
      userId,
    );
    await scheduleDelayedSyncJob(
      { providerId: provider.id, userId, targetRefreshWindow: { type: "days", days: 1 } },
      cooldown,
    );
    await completeCredentialReconnect({ db: context.db, userId }, provider, (transaction) =>
      saveTokens(transaction, provider.id, tokens, userId),
    );
    const delayed = await getProviderSyncQueue(provider.id).getDelayed();
    expect(delayed.map((job) => job.data.targetRefreshWindow)).toEqual(
      expect.arrayContaining([{ type: "days", days: 1 }, { type: "full" }]),
    );
    const reconnect = delayed.find((job) => job.id?.startsWith("sync-reconnect-"));
    expect(reconnect?.opts.delay).toBeGreaterThan(0);
  });

  it("bounds stalled Redis commands and releases the erasure lock after dispatch fails", async () => {
    await closeAllQueueResources();
    const originalUrl = process.env.REDIS_URL;
    if (!originalUrl) throw new Error("REDIS_URL is required");
    const upstreamUrl = new URL(originalUrl);
    let stalled = false;
    const sockets = new Set<Socket>();
    const proxy = createServer((socket) => {
      const upstream = createConnection({
        host: upstreamUrl.hostname,
        port: Number(upstreamUrl.port || 6379),
      });
      sockets.add(socket);
      sockets.add(upstream);
      socket.on("data", (data) => {
        if (!stalled) upstream.write(data);
      });
      upstream.on("data", (data) => {
        if (!stalled) socket.write(data);
      });
      socket.on("close", () => upstream.destroy());
      upstream.on("close", () => socket.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Redis proxy address missing");
    const proxyUrl = new URL(originalUrl);
    proxyUrl.hostname = "127.0.0.1";
    proxyUrl.port = String(address.port);
    process.env.REDIS_URL = proxyUrl.toString();
    const queue = getProviderSyncQueue(provider.id);
    const sharedClient = await getSharedRedisConnection().client;
    await queue.waitUntilReady();
    cleanupRedisProxy = async () => {
      stalled = false;
      await queue.close();
      sharedClient.disconnect();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
      await closeAllQueueResources();
      process.env.REDIS_URL = originalUrl;
    };
    stalled = true;
    const startedAt = Date.now();
    const results = await Promise.allSettled([
      sharedClient.get("reconnect-timeout-fixture"),
      completeCredentialReconnect({ db: context.db, userId }, provider, (transaction) =>
        saveTokens(transaction, provider.id, tokens, userId),
      ),
    ]);
    expect(results[0]).toMatchObject({
      status: "rejected",
      reason: { message: "Command timed out" },
    });
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: {
        message: "Reconnect Test connected, but its sync could not be started. Try Sync again.",
      },
    });
    expect(Date.now() - startedAt).toBeLessThan(7_000);
    await withAccountErasureUserWriteFence(context.db, userId, async () => undefined);
  }, 8_000);

  it("rejects reconnect writes and dispatch after erasure begins", async () => {
    await initiateAccountErasure(
      context.db,
      userId,
      async () => "encrypted-test-snapshot",
      async () => undefined,
    );
    const queue = getProviderSyncQueue(provider.id);
    const before = await queue.getJobCounts();
    await expect(
      completeCredentialReconnect({ db: context.db, userId }, provider, (transaction) =>
        saveTokens(transaction, provider.id, { ...tokens, accessToken: "should-not-save" }, userId),
      ),
    ).rejects.toThrow();
    expect(await loadTokens(context.db, provider.id, userId)).toMatchObject(tokens);
    expect(await queue.getJobCounts()).toEqual(before);
  });
});
