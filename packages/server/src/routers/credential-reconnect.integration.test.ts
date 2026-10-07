import { randomUUID } from "node:crypto";
import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { Worker } from "bullmq";
import { initiateAccountErasure } from "dofek/db/account-erasure";
import { loadTokens, saveTokens } from "dofek/db/tokens";
import { scheduleDelayedSyncJob } from "dofek/jobs/enqueue-sync-job";
import { providerRateLimitCooldownStore } from "dofek/jobs/provider-rate-limit-cooldown";
import {
  closeAllQueueResources,
  getProviderSyncQueue,
  getRedisConnection,
} from "dofek/jobs/queues";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { completeCredentialReconnect } from "./credential-reconnect.ts";

describe("credential reconnect persistence and dispatch", () => {
  let context: TestContext;
  const provider = { id: `reconnect-test-${randomUUID()}`, name: "Reconnect Test" };
  const userId = randomUUID();
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
