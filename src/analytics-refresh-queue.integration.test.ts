import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Queue, QueueEvents, Worker } from "bullmq";
import { describe, expect, it } from "vitest";
import {
  enqueueAnalyticsRefresh,
  enqueueAnalyticsRefreshAndWait,
  runAnalyticsRefreshJobs,
} from "./analytics-refresh-queue.ts";
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

describe("awaited analytics refresh", () => {
  it("joins queued requests, schedules after an active build, and waits for actual completion", async () => {
    const connection = getRedisConnection();
    const queue = new Queue<AnalyticsRefreshJobData>(`test-analytics-wait-${randomUUID()}`, {
      connection,
    });
    const events = new QueueEvents(queue.name, { connection });
    const controller = new AbortController();
    const started = deferred();
    const finish = deferred();
    const nextStarted = deferred();
    const finishNext = deferred();
    let builds = 0;
    let consumer: Promise<void> | undefined;
    try {
      await events.waitUntilReady();
      await queue.pause();
      await enqueueAnalyticsRefresh(queue);
      let settled = false;
      const waiting = enqueueAnalyticsRefreshAndWait(
        queue,
        events,
        new AbortController().signal,
      ).then(() => {
        settled = true;
      });
      consumer = runAnalyticsRefreshJobs({
        queue,
        connection,
        intervalMilliseconds: 900_000,
        signal: controller.signal,
        reportFailure: () => {},
        processRefresh: async () => {
          builds += 1;
          if (builds === 1) {
            started.resolve();
            await finish.promise;
          } else {
            nextStarted.resolve();
            await finishNext.promise;
          }
        },
      });
      await queue.resume();
      await started.promise;
      expect(settled).toBe(false);
      const followup = enqueueAnalyticsRefreshAndWait(queue, events, new AbortController().signal);
      finish.resolve();
      await waiting;
      await nextStarted.promise;
      expect(builds).toBe(2);
      finishNext.resolve();
      await followup;
      expect(builds).toBe(2);
    } finally {
      controller.abort();
      finish.resolve();
      finishNext.resolve();
      await consumer;
      await events.close();
      await queue.obliterate();
      await queue.close();
    }
  }, 15_000);

  it("rejects an unfinished refresh wait when worker shutdown cancels it", async () => {
    const connection = getRedisConnection();
    const queue = new Queue<AnalyticsRefreshJobData>(`test-analytics-shutdown-${randomUUID()}`, {
      connection,
    });
    const events = new QueueEvents(queue.name, { connection });
    const registered = deferred();
    EventEmitter.prototype.on.call(queue, "newListener", (event: string | symbol) => {
      if (event === "closing") registered.resolve();
    });
    const controller = new AbortController();
    const waiting = enqueueAnalyticsRefreshAndWait(queue, events, controller.signal);
    const rejected = expect(waiting).rejects.toThrow();
    try {
      await registered.promise;
      controller.abort(new Error("Worker shutdown"));
      await rejected;
    } finally {
      await events.close();
      const cleanup = new Queue(queue.name, { connection });
      await cleanup.obliterate();
      await cleanup.close();
      await queue.close();
    }
  }, 15_000);

  it("observes an already completed handle and propagates the worker failure", async () => {
    const connection = getRedisConnection();
    const queue = new Queue<AnalyticsRefreshJobData>(`test-analytics-completed-${randomUUID()}`, {
      connection,
    });
    const events = new QueueEvents(queue.name, { connection });
    let worker: Worker | undefined;
    let fail = false;
    try {
      await events.waitUntilReady();
      worker = new Worker(
        queue.name,
        async () => {
          if (fail) throw new Error("Projection failed");
          return "done";
        },
        { connection },
      );
      await enqueueAnalyticsRefreshAndWait(
        {
          add: async (...args) => {
            const job = await queue.add(...args);
            await job.waitUntilFinished(events);
            return job;
          },
        },
        events,
        new AbortController().signal,
      );
      fail = true;
      await expect(
        enqueueAnalyticsRefreshAndWait(queue, events, new AbortController().signal),
      ).rejects.toThrow("Projection failed");
    } finally {
      await worker?.close();
      await events.close();
      await queue.obliterate();
      await queue.close();
    }
  }, 15_000);
});
