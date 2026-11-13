import { randomUUID } from "node:crypto";
import { Queue, UnrecoverableError, Worker } from "bullmq";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ActivityAnalyticsJobData,
  enqueueActivityRecomputeAnalyticsRefresh,
  getRedisConnection,
} from "./queues.ts";

describe("activity recompute job lifecycle (Redis integration)", () => {
  const cleanupFunctions: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanupFunction of cleanupFunctions.reverse()) await cleanupFunction();
    cleanupFunctions.length = 0;
  });

  function createTestQueue(): Queue<ActivityAnalyticsJobData> {
    const queue = new Queue<ActivityAnalyticsJobData>(`test-activity-recompute-${randomUUID()}`, {
      connection: getRedisConnection(),
    });
    cleanupFunctions.push(async () => {
      await queue.obliterate({ force: true });
      await queue.close();
    });
    return queue;
  }

  async function processNextJob(
    queue: Queue<ActivityAnalyticsJobData>,
    outcome: "complete" | "fail",
  ): Promise<void> {
    let finished = () => {};
    const settled = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const worker = new Worker<ActivityAnalyticsJobData>(
      queue.name,
      async () => {
        if (outcome === "fail") throw new UnrecoverableError("analytics build failed");
      },
      { connection: getRedisConnection() },
    );
    worker.on("completed", () => finished());
    worker.on("failed", () => finished());
    await settled;
    await worker.close();
  }

  it("keeps completion observable and starts new work for a later recompute of the same activity", async () => {
    const queue = createTestQueue();
    const userId = randomUUID();
    const activityIds = [randomUUID()];

    const firstJobId = await enqueueActivityRecomputeAnalyticsRefresh(userId, activityIds, queue);
    if (!firstJobId) throw new Error("expected a recompute job id");
    await processNextJob(queue, "complete");

    expect(await (await queue.getJob(firstJobId))?.getState()).toBe("completed");

    const secondJobId = await enqueueActivityRecomputeAnalyticsRefresh(userId, activityIds, queue);
    expect(secondJobId).toBe(firstJobId);
    expect(await (await queue.getJob(firstJobId))?.getState()).toBe("waiting");
    await processNextJob(queue, "complete");
    expect(await (await queue.getJob(firstJobId))?.getState()).toBe("completed");
  });

  it("retries a failed recompute of the same activity instead of skipping it", async () => {
    const queue = createTestQueue();
    const userId = randomUUID();
    const activityIds = [randomUUID()];

    const jobId = await enqueueActivityRecomputeAnalyticsRefresh(userId, activityIds, queue);
    if (!jobId) throw new Error("expected a recompute job id");
    await processNextJob(queue, "fail");
    expect(await (await queue.getJob(jobId))?.getState()).toBe("failed");

    await enqueueActivityRecomputeAnalyticsRefresh(userId, activityIds, queue);
    expect(await (await queue.getJob(jobId))?.getState()).toBe("waiting");
  });

  it("deduplicates a recompute that is still waiting", async () => {
    const queue = createTestQueue();
    const userId = randomUUID();
    const activityIds = [randomUUID()];

    const firstJobId = await enqueueActivityRecomputeAnalyticsRefresh(userId, activityIds, queue);
    const secondJobId = await enqueueActivityRecomputeAnalyticsRefresh(userId, activityIds, queue);

    expect(secondJobId).toBe(firstJobId);
    expect(await queue.getJobCounts("waiting")).toEqual({ waiting: 1 });
  });
});
