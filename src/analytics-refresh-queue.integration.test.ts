import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { describe, expect, it } from "vitest";
import { enqueueAnalyticsRefresh, runAnalyticsRefreshJobs } from "./analytics-refresh-queue.ts";
import { type AnalyticsRefreshJobData, getRedisConnection } from "./jobs/queues.ts";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("analytics refresh queue (Redis integration)", () => {
  it("durably combines requests, wakes immediately, and serializes the next batch across consumers", async () => {
    const connection = getRedisConnection();
    const queue = new Queue<AnalyticsRefreshJobData>(`test-analytics-${randomUUID()}`, {
      connection,
    });
    const controller = new AbortController();
    const firstStarted = deferred();
    const secondStarted = deferred();
    const finishFirst = deferred();
    const finishSecond = deferred();
    const errors: Error[] = [];
    let builds = 0;
    let active = 0;
    let maximumActive = 0;
    let consumers: Promise<void>[] = [];
    const processRefresh = async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      builds += 1;
      if (builds === 1) {
        firstStarted.resolve();
        await finishFirst.promise;
      } else {
        secondStarted.resolve();
        await finishSecond.promise;
      }
      active -= 1;
    };

    try {
      await queue.pause();
      await Promise.all(Array.from({ length: 5 }, () => enqueueAnalyticsRefresh(queue)));
      expect(await queue.getWaitingCount()).toBe(1);

      consumers = Array.from({ length: 2 }, () =>
        runAnalyticsRefreshJobs({
          queue,
          connection,
          processRefresh,
          intervalMilliseconds: 900_000,
          reportFailure: (error) => errors.push(error),
          signal: controller.signal,
        }),
      );
      await queue.resume();
      await firstStarted.promise;

      await Promise.all(Array.from({ length: 5 }, () => enqueueAnalyticsRefresh(queue)));
      const waiting = await queue.getWaiting();
      expect(waiting.filter((job) => job.name === "analytics-refresh")).toHaveLength(1);

      finishFirst.resolve();
      await secondStarted.promise;
      expect(builds).toBe(2);
      expect(maximumActive).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      controller.abort();
      finishFirst.resolve();
      finishSecond.resolve();
      await Promise.all(consumers);
      await queue.obliterate();
      await queue.close();
    }
  }, 15_000);
});
