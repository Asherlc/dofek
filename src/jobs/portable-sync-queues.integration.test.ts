import type { ConnectionOptions, Processor } from "bullmq";
import { type Queue, RedisConnection, Worker } from "bullmq";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runPortableSyncQueues } from "./portable-sync-queues.ts";
import { createPortableSyncSlot } from "./portable-sync-slot.ts";
import { getProviderQueueConfig } from "./provider-queue-config.ts";
import {
  createProviderSyncQueue,
  getRedisConnection,
  providerSyncQueueName,
  type SyncJobData,
} from "./queues.ts";

/**
 * Real-Redis coverage for the portable one-job-at-a-time queue selector.
 *
 * Run with an integration REDIS_URL, e.g.:
 *   REDIS_URL=redis://127.0.0.1:55459 \
 *     pnpm exec vitest run --project integration \
 *     src/jobs/portable-sync-queues.integration.test.ts --retry=0
 *
 * Provider queue names are the real ones (providerSyncQueueName); each test
 * obliterates the queues it touches so no production-style queue is reused.
 */

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {
    throw new Error("Deferred promise was not initialized");
  };
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

describe("portable sync queues (integration)", () => {
  let connection: ConnectionOptions;
  let slotConnection: RedisConnection;
  const cleanups: Array<() => Promise<void>> = [];
  const runners: Array<{ controller: AbortController; done: Promise<void> }> = [];

  beforeAll(() => {
    connection = { ...getRedisConnection(), db: 15 };
    slotConnection = new RedisConnection(connection, { blocking: false });
  });
  afterAll(() => slotConnection.close());

  afterEach(async () => {
    for (const runner of runners) runner.controller.abort();
    try {
      await Promise.all(runners.splice(0).map((runner) => runner.done));
    } finally {
      await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
    }
  });

  async function freshQueue(providerId: string): Promise<Queue<SyncJobData>> {
    const queue = createProviderSyncQueue(providerId, connection);
    await queue.obliterate({ force: true });
    cleanups.push(async () => {
      try {
        await queue.obliterate({ force: true });
      } finally {
        await queue.close();
      }
    });
    return queue;
  }

  function start(providerIds: string[], processor: Processor<SyncJobData>): AbortController {
    const controller = new AbortController();
    const done = slotConnection.client.then((redis) => {
      return runPortableSyncQueues({
        providerIds,
        connection,
        processor,
        signal: controller.signal,
        slot: createPortableSyncSlot(redis),
        onReady: () => {},
      });
    });
    runners.push({ controller, done });
    return controller;
  }

  it("claims one job at a time and rotates across two provider queues with normal queue ids", async () => {
    const providerIds = ["wahoo", "peloton"];
    const queues = await Promise.all(providerIds.map(freshQueue));
    expect(queues.map((queue) => queue.name)).toEqual(providerIds.map(providerSyncQueueName));

    for (const [index, queue] of queues.entries()) {
      await queue.add(
        "sync",
        { userId: `${providerIds[index]}-a`, providerId: providerIds[index] },
        { jobId: `${providerIds[index]}-a` },
      );
      await queue.add(
        "sync",
        { userId: `${providerIds[index]}-b`, providerId: providerIds[index] },
        { jobId: `${providerIds[index]}-b` },
      );
    }

    const processed: string[] = [];
    let active = 0;
    let peak = 0;
    const controller = start(providerIds, async (job) => {
      active += 1;
      peak = Math.max(peak, active);
      processed.push(`${job.data.providerId}:${job.id}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    });

    await waitFor(() => processed.length === 4, 6_000);
    controller.abort();

    expect(peak).toBe(1);
    expect(processed.filter((id) => id.startsWith("wahoo:"))).toHaveLength(2);
    expect(processed.filter((id) => id.startsWith("peloton:"))).toHaveLength(2);
    expect(processed).toContain("wahoo:wahoo-a");
    expect(processed).toContain("peloton:peloton-b");
  }, 30_000);

  it("picks up work added after an empty sweep and exits cleanly on abort", async () => {
    const providerIds = ["wahoo"];
    const queue = await freshQueue("wahoo");
    const claimed = deferred<string>();
    const controller = start(providerIds, async (job) => {
      claimed.resolve(job.data.userId);
    });

    // Several idle polls pass with no work before the job is enqueued.
    await new Promise((resolve) => setTimeout(resolve, 350));
    await queue.add("sync", { userId: "late-user" });

    expect(await claimed.promise).toBe("late-user");
    controller.abort();
  }, 30_000);

  it("skips a rate-limited provider without delaying other queues", async () => {
    const providerIds = ["whoop", "wahoo"];
    const [limited, ready] = await Promise.all([freshQueue("whoop"), freshQueue("wahoo")]);
    const config = getProviderQueueConfig("whoop");
    if (!config.limiter) throw new Error("This fixture requires a rate limiter");

    const limitedJob = await limited.add("sync", { userId: "limited-user" });
    await ready.add("sync", { userId: "ready-user" });
    await limited.rateLimit(4_000);
    expect(await limited.getRateLimitTtl(config.limiter.max)).toBeGreaterThan(0);

    const processed: string[] = [];
    const controller = start(providerIds, async (job) => {
      processed.push(job.data.userId);
    });

    await waitFor(() => processed.includes("ready-user"), 4_000);
    controller.abort();

    expect(processed).toContain("ready-user");
    expect(processed).not.toContain("limited-user");
    expect(await limitedJob.getState()).toBe("waiting");
  }, 30_000);

  it("holds native global concurrency at the provider cap while a native worker shares the queue", async () => {
    const providerId = "strava";
    const config = getProviderQueueConfig(providerId);
    const cap = config.concurrency;
    expect(cap).toBeGreaterThan(1);
    const queue = await freshQueue(providerId);

    const release = deferred<void>();
    const processed: string[] = [];
    let active = 0;
    let peak = 0;
    const sharedProcessor: Processor<SyncJobData> = async (job) => {
      active += 1;
      peak = Math.max(peak, active);
      processed.push(job.data.userId);
      await release.promise;
      active -= 1;
    };
    const controller = start([providerId], sharedProcessor);
    const native = new Worker<SyncJobData>(queue.name, sharedProcessor, {
      connection,
      concurrency: cap,
      autorun: false,
    });
    cleanups.push(async () => native.close());
    try {
      for (let i = 0; i < 4; i += 1) {
        await queue.add("sync", { userId: `shared-${i}` });
      }
      await waitFor(() => active === 1, 5_000);
      expect(await queue.getGlobalConcurrency()).toBe(cap);

      void native.run();
      await waitFor(() => active === cap, 5_000);
      expect(await queue.getActiveCount()).toBe(cap);
      release.resolve();
      await waitFor(() => processed.length === 4, 5_000);
    } finally {
      release.resolve();
      controller.abort();
    }
    expect(peak).toBeLessThanOrEqual(cap);
    expect(new Set(processed).size).toBe(4);
  }, 45_000);

  it("visits a queued second candidate even when the first and third are idle", async () => {
    const providerIds = ["wahoo", "peloton", "oura"];
    const queues = await Promise.all([
      freshQueue("wahoo"),
      freshQueue("peloton"),
      freshQueue("oura"),
    ]);
    expect(queues.map((queue) => queue.name)).toEqual(providerIds.map(providerSyncQueueName));

    // Only the middle candidate has work. Advancing the round-robin cursor
    // twice per visit (offset plus a mutated cursor) would skip it forever.
    await queues[1].add("sync", { userId: "middle-user", providerId: "peloton" });

    const processed: string[] = [];
    const controller = start(providerIds, async (job) => {
      processed.push(job.data.userId);
    });

    await waitFor(() => processed.includes("middle-user"), 5_000);
    controller.abort();

    expect(processed).toEqual(["middle-user"]);
  }, 30_000);

  it("leaves a failed job's retry to BullMQ and keeps selecting", async () => {
    const providerIds = ["wahoo"];
    const queue = await freshQueue("wahoo");

    await queue.add(
      "sync",
      { userId: "retry-user", providerId: "wahoo" },
      { attempts: 2, backoff: { type: "fixed", delay: 50 } },
    );

    const attempts: number[] = [];
    const controller = start(providerIds, async (job) => {
      attempts.push(job.attemptsMade);
      if (job.attemptsMade === 0) {
        throw new Error("first attempt fails");
      }
    });

    await waitFor(() => attempts.length === 2, 8_000);
    controller.abort();

    // The worker closes after the first failed attempt; BullMQ moves the job
    // to delayed, and the next sweep's delayed-count check opens a fresh worker
    // that promotes and runs the retry. No selector-level retry is involved.
    expect(attempts).toEqual([0, 1]);
  }, 30_000);

  it("promotes a due delayed job through a short-lived worker", async () => {
    const providerIds = ["wahoo"];
    const queue = await freshQueue("wahoo");

    const job = await queue.add("sync", { userId: "delayed-user" }, { delay: 500 });
    expect(await job.getState()).toBe("delayed");

    const processed: string[] = [];
    const controller = start(providerIds, async (j) => {
      processed.push(j.data.userId);
    });

    await waitFor(() => processed.includes("delayed-user"), 6_000);
    controller.abort();

    expect(processed).toEqual(["delayed-user"]);
  }, 30_000);
});
