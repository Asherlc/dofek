import { randomUUID } from "node:crypto";
import type { ConnectionOptions } from "bullmq";
import { Job, Queue, QueueEvents, Worker } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncJobData } from "./queues.ts";
import {
  type EnqueuedSyncJob,
  enqueueSyncJobWithRequestDedup,
  syncCoordinatorHasDispatchedProvider,
} from "./sync-request-job.ts";

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

  it("deduplicates Ziva date chunks by their complete window and source account", async () => {
    vi.resetModules();
    const [
      { registerSyncRequestQueryResolver },
      { resolveZivaSyncRequestQuery },
      { enqueueSyncJobWithRequestDedup: enqueueWithFreshResolverRegistry },
    ] = await Promise.all([
      import("../lib/sync-request-query.ts"),
      import("../providers/ziva/sync-request-query.ts"),
      import("./sync-request-job.ts"),
    ]);
    registerSyncRequestQueryResolver("ziva", resolveZivaSyncRequestQuery);

    const { queue } = createQueue("ziva-checkpoint");
    const baseJobData: SyncJobData = {
      userId: "user-1",
      providerId: "ziva",
      sinceIso: "2026-09-01T00:00:00.000Z",
      untilIso: "2026-09-30T23:59:59.999Z",
    };
    const initial = await enqueueWithFreshResolverRegistry(
      "ziva",
      baseJobData,
      {},
      (name, data, options) => queue.add(name, data, options),
      (jobId) => queue.getJob(jobId),
    );
    const differentEndWindow = await enqueueWithFreshResolverRegistry(
      "ziva",
      {
        ...baseJobData,
        untilIso: "2026-10-01T23:59:59.999Z",
      },
      {},
      (name, data, options) => queue.add(name, data, options),
      (jobId) => queue.getJob(jobId),
    );
    const continuationJobData: SyncJobData = {
      ...baseJobData,
      checkpoint: {
        version: 1,
        sourceAccountKey: "opaque-source-account-key",
        nextDate: "2026-09-15",
        endDate: "2026-09-30",
        recordsSynced: 14,
      },
    };
    const continuation = await enqueueWithFreshResolverRegistry(
      "ziva",
      continuationJobData,
      {},
      (name, data, options) => queue.add(name, data, options),
      (jobId) => queue.getJob(jobId),
    );
    const differentAccountContinuation = await enqueueWithFreshResolverRegistry(
      "ziva",
      {
        ...continuationJobData,
        checkpoint: {
          version: 1,
          sourceAccountKey: "different-opaque-source-account-key",
          nextDate: "2026-09-15",
          endDate: "2026-09-30",
          recordsSynced: 14,
        },
      },
      {},
      (name, data, options) => queue.add(name, data, options),
      (jobId) => queue.getJob(jobId),
    );
    const duplicateContinuation = await enqueueWithFreshResolverRegistry(
      "ziva",
      continuationJobData,
      {},
      (name, data, options) => queue.add(name, data, options),
      (jobId) => queue.getJob(jobId),
    );

    expect(differentEndWindow?.id).not.toBe(initial?.id);
    expect(continuation?.id).not.toBe(initial?.id);
    expect(differentAccountContinuation?.id).not.toBe(continuation?.id);
    expect(duplicateContinuation?.id).toBe(continuation?.id);
    expect(duplicateContinuation?.alreadyQueued).toBe(true);
    expect(await queue.getWaitingCount()).toBe(4);
  });

  function manualWorker(queue: Queue<SyncJobData>, connection: ConnectionOptions) {
    const worker = new Worker<SyncJobData>(queue.name, async () => undefined, {
      connection,
      autorun: false,
    });
    cleanup.push(async () => worker.close());
    return worker;
  }

  async function activeJob(worker: Worker<SyncJobData>, token: string) {
    const job = await worker.getNextJob(token, { block: false });
    if (!job) throw new Error("Expected an active integration job");
    return job;
  }

  async function dispatchChild(
    parent: Job<SyncJobData>,
    queue: Queue<SyncJobData>,
    providerId: string,
    options: import("bullmq").JobsOptions = {},
    loseAcknowledgement = false,
  ) {
    if (!parent.id) throw new Error("Expected coordinator ID");
    if (
      syncCoordinatorHasDispatchedProvider(
        await parent.getDependencies(),
        parent.id,
        providerId,
        parent.data.userId,
      )
    ) {
      return;
    }
    return enqueueSyncJobWithRequestDedup(
      providerId,
      { ...parent.data, providerId },
      options,
      async (name, data, opts) => {
        const job = await queue.add(name, data, opts);
        if (loseAcknowledgement) throw new Error("Enqueue acknowledgement lost");
        return job;
      },
      (id) => queue.getJob(id),
      { id: parent.id, queueQualifiedName: parent.queueQualifiedName },
    );
  }

  it("recovers partial dispatch after lost acknowledgement and completed-child pruning", async () => {
    const { queue: parentQueue, connection } = createQueue("coordinator-recovery");
    const { queue: childQueue } = createQueue("coordinator-recovery-children");
    const parentWorker = manualWorker(parentQueue, connection);
    const childWorker = manualWorker(childQueue, connection);
    const originalData: SyncJobData = {
      userId: "user-1",
      sinceIso: "2026-09-20T00:00:00.000Z",
      untilIso: "2026-09-21T23:59:59.999Z",
      requestedAtIso: "2026-09-21T06:30:00.000Z",
    };
    await parentQueue.add("sync", originalData, { attempts: 2 });
    const firstParent = await activeJob(parentWorker, "parent-first");
    await expect(
      dispatchChild(firstParent, childQueue, "a", { removeOnComplete: true }, true),
    ).rejects.toThrow("Enqueue acknowledgement lost");
    await firstParent.moveToFailed(
      new Error("Enqueue acknowledgement lost"),
      "parent-first",
      false,
    );
    const firstChild = await activeJob(childWorker, "child-a");
    expect(firstChild.data).toEqual({ ...originalData, providerId: "a" });
    await firstChild.moveToCompleted(null, "child-a", false);
    expect(await childQueue.getJob(firstChild.id ?? "")).toBeUndefined();

    const restoredParent = await Job.fromId<SyncJobData>(parentQueue, firstParent.id ?? "");
    if (!restoredParent) throw new Error("Expected durable coordinator after retry");
    expect(
      await dispatchChild(restoredParent, childQueue, "a", { removeOnComplete: true }),
    ).toBeUndefined();
    expect(await childQueue.getWaitingCount()).toBe(0);
    const retryParent = await activeJob(parentWorker, "parent-retry");
    expect(retryParent.attemptsMade).toBe(1);
    await dispatchChild(retryParent, childQueue, "b", { removeOnComplete: true });
    expect(await retryParent.moveToWaitingChildren("parent-retry")).toBe(true);
    expect(await retryParent.getState()).toBe("waiting-children");
    const secondChild = await activeJob(childWorker, "child-b");
    expect(secondChild.data).toEqual({ ...originalData, providerId: "b" });
    await secondChild.moveToCompleted(null, "child-b", false);
    expect(await childQueue.getJob(secondChild.id ?? "")).toBeUndefined();

    const finalParent = await activeJob(parentWorker, "parent-final");
    await dispatchChild(finalParent, childQueue, "a");
    await dispatchChild(finalParent, childQueue, "b");
    expect(await childQueue.getWaitingCount()).toBe(0);
    expect(await finalParent.moveToWaitingChildren("parent-final")).toBe(false);
    await finalParent.moveToCompleted(null, "parent-final", false);
    expect(await finalParent.getState()).toBe("completed");
    expect(Object.keys((await finalParent.getDependencies()).processed ?? {})).toHaveLength(2);
  });

  it("retains ignored terminal failures after pruning while another child owns its delay and retries", async () => {
    const { queue: parentQueue, connection } = createQueue("coordinator-failure");
    const { queue: childQueue } = createQueue("coordinator-failure-children");
    const parentWorker = manualWorker(parentQueue, connection);
    const childWorker = manualWorker(childQueue, connection);
    await parentQueue.add("sync", { userId: "user-1" });
    const parent = await activeJob(parentWorker, "parent");
    await dispatchChild(parent, childQueue, "a", { attempts: 1, removeOnFail: true });
    const delayed = await dispatchChild(parent, childQueue, "b", {
      attempts: 288,
      backoff: { type: "fixed", delay: 300_000 },
      delay: 60_000,
      removeOnComplete: true,
    });
    expect(delayed?.opts).toMatchObject({
      attempts: 288,
      backoff: { type: "fixed", delay: 300_000 },
      delay: 60_000,
      parent: { id: parent.id, queue: parent.queueQualifiedName },
      ignoreDependencyOnFailure: true,
    });
    expect(await parent.moveToWaitingChildren("parent")).toBe(true);
    const failed = await activeJob(childWorker, "child-fail");
    await failed.moveToFailed(new Error("Terminal provider failure"), "child-fail", false);
    expect(await childQueue.getJob(failed.id ?? "")).toBeUndefined();
    expect(Object.values((await parent.getDependencies()).ignored ?? {})).toEqual([
      "Terminal provider failure",
    ]);
    expect(await dispatchChild(parent, childQueue, "a")).toBeUndefined();
    expect(await parent.getState()).toBe("waiting-children");
    if (!delayed) throw new Error("Expected delayed provider child");
    await delayed.promote();
    const successful = await activeJob(childWorker, "child-success");
    await successful.moveToCompleted(null, "child-success", false);
    const resumed = await activeJob(parentWorker, "parent-resumed");
    expect(await resumed.moveToWaitingChildren("parent-resumed")).toBe(false);
    await resumed.moveToCompleted(null, "parent-resumed", false);
    expect(await resumed.getState()).toBe("completed");
    expect(await dispatchChild(resumed, childQueue, "a")).toBeUndefined();
    expect(await childQueue.getWaitingCount()).toBe(0);
  });
});
