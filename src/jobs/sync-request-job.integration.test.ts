import { randomUUID } from "node:crypto";
import type { ConnectionOptions } from "bullmq";
import { Queue, QueueEvents, Worker } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncJobData } from "./queues.ts";
import { type EnqueuedSyncJob, enqueueSyncJobWithRequestDedup } from "./sync-request-job.ts";

function testRedisConnection(): ConnectionOptions {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is required for BullMQ integration tests");
  }
  const parsed = new URL(redisUrl);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || "6379"),
    password: parsed.password || undefined,
    maxRetriesPerRequest: null,
  };
}

describe("full sync BullMQ lifecycle deduplication", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const close = cleanup.pop();
      if (close) await close();
    }
  });

  function createQueue(suffix: string) {
    const connection = testRedisConnection();
    const queue = new Queue<SyncJobData>(`test-full-sync-${suffix}-${randomUUID()}`, {
      connection,
    });
    const events = new QueueEvents(queue.name, { connection });
    cleanup.push(async () => {
      await queue.obliterate({ force: true });
      await queue.close();
    });
    cleanup.push(async () => events.close());
    return { connection, events, queue };
  }

  it("fails loudly when REDIS_URL is missing", () => {
    vi.stubEnv("REDIS_URL", "");
    try {
      expect(testRedisConnection).toThrow("REDIS_URL is required for BullMQ integration tests");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  async function enqueueFull(
    queue: Queue<SyncJobData>,
    untilIso: string,
    providerId = "strava",
  ): Promise<EnqueuedSyncJob> {
    const result = await enqueueSyncJobWithRequestDedup(
      providerId,
      {
        userId: "user-1",
        providerId,
        sinceIso: "1970-01-01T00:00:00.000Z",
        untilIso,
        targetRefreshWindow: { type: "full" },
      },
      { deduplication: { id: `sync:full:${providerId}:user-1` } },
      (name, data, options) => queue.add(name, data, options),
      (jobId) => queue.getJob(jobId),
    );
    if (!result) throw new Error("Expected a queued full sync job");
    return result;
  }

  it("coalesces pending full syncs and releases the key after completion", async () => {
    const { connection, events, queue } = createQueue("complete");
    await events.waitUntilReady();

    const first = await enqueueFull(queue, "2026-07-29T17:00:00.000Z");
    const duplicate = await enqueueFull(queue, "2026-07-29T17:00:01.000Z");

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.alreadyQueued).toBe(true);
    expect(await queue.getWaitingCount()).toBe(1);

    const worker = new Worker<SyncJobData>(queue.name, async () => undefined, { connection });
    cleanup.push(async () => worker.close());
    await first.waitUntilFinished(events);

    const later = await enqueueFull(queue, "2026-07-29T17:00:02.000Z");
    expect(later.id).not.toBe(first.id);
    expect(later.alreadyQueued).toBe(false);
  });

  it("releases the key after failure", async () => {
    const { connection, events, queue } = createQueue("failure");
    await events.waitUntilReady();

    const first = await enqueueFull(queue, "2026-07-29T17:00:00.000Z");
    const worker = new Worker<SyncJobData>(
      queue.name,
      async () => {
        throw new Error("provider rejected sync");
      },
      { connection },
    );
    cleanup.push(async () => worker.close());
    await expect(first.waitUntilFinished(events)).rejects.toThrow("provider rejected sync");

    const later = await enqueueFull(queue, "2026-07-29T17:00:01.000Z");
    expect(later.id).not.toBe(first.id);
    expect(later.alreadyQueued).toBe(false);
  });

  it("keeps checkpoint continuations distinct from the pending initial operation", async () => {
    vi.resetModules();
    const [
      { registerSyncRequestQueryResolver },
      { resolveWhoopSyncRequestQuery },
      { enqueueSyncJobWithRequestDedup: enqueueWithFreshResolverRegistry },
    ] = await Promise.all([
      import("../lib/sync-request-query.ts"),
      import("../providers/whoop/sync-request-query.ts"),
      import("./sync-request-job.ts"),
    ]);
    registerSyncRequestQueryResolver("whoop", resolveWhoopSyncRequestQuery);

    const { queue } = createQueue("checkpoint");
    const initial = await enqueueFull(queue, "2026-07-29T17:00:00.000Z", "whoop");

    const continuation = await enqueueWithFreshResolverRegistry(
      "whoop",
      {
        userId: "user-1",
        providerId: "whoop",
        sinceIso: "1970-01-01T00:00:00.000Z",
        untilIso: "2026-07-29T17:00:00.000Z",
        targetRefreshWindow: { type: "full" },
        checkpoint: {
          runId: "run-1",
          recordsSynced: 0,
          phase: "bootstrap",
          cycleFetchCursorMs: 123,
          cycles: [],
          apiSteps: [],
          apiStepIndex: 0,
          presentExternalIds: [],
        },
      },
      {},
      (name, data, options) => queue.add(name, data, options),
      (jobId) => queue.getJob(jobId),
    );

    expect(continuation?.id).not.toBe(initial.id);
    expect(await queue.getWaitingCount()).toBe(2);
  });
});
