import { Job, QueueEvents } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAnalyticsRefreshQueue } from "./jobs/queues.ts";

const mocks = vi.hoisted(() => ({
  close: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  run: vi.fn(),
  Worker: vi.fn(),
  Queue: vi.fn(),
  QueueEvents: vi.fn(),
  Job: vi.fn(),
  ready: vi.fn().mockResolvedValue({}),
  finished: vi.fn().mockResolvedValue(undefined),
  add: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("bullmq", () => ({
  Worker: mocks.Worker,
  Queue: mocks.Queue,
  QueueEvents: mocks.QueueEvents,
  Job: mocks.Job,
  FlowProducer: vi.fn(),
  RedisConnection: vi.fn(),
}));

import {
  enqueueAnalyticsRefresh,
  enqueueAnalyticsRefreshAndWait,
  runAnalyticsRefreshJobs,
} from "./analytics-refresh-queue.ts";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.Worker.mockImplementation(function vitestConstructor() {
    return { close: mocks.close, on: mocks.on, run: mocks.run };
  });
  mocks.QueueEvents.mockImplementation(function vitestConstructor() {
    return { waitUntilReady: mocks.ready };
  });
  mocks.Job.mockImplementation(function vitestConstructor() {
    return { waitUntilFinished: mocks.finished };
  });
  mocks.Queue.mockImplementation(function vitestConstructor() {
    return { add: mocks.add };
  });
});

describe("analytics refresh requests", () => {
  it("uses the supplied Redis connection and combines requests until processing starts", async () => {
    const queue = createAnalyticsRefreshQueue({ host: "test", port: 9999 });
    await enqueueAnalyticsRefresh(queue);
    expect(mocks.Queue).toHaveBeenCalledWith("analytics-refresh", {
      connection: { host: "test", port: 9999 },
    });
    expect(mocks.add).toHaveBeenCalledWith(
      "analytics-refresh",
      { type: "analytics-refresh" },
      {
        deduplication: { id: "analytics-refresh" },
        removeOnComplete: { age: 604_800, count: 1_000 },
        removeOnFail: { age: 604_800, count: 1_000 },
      },
    );
  });

  it("uses the production Redis URL and bounds dispatch commands", () => {
    vi.stubEnv("REDIS_URL", "redis://:queue-password@queue-host:6382");
    try {
      createAnalyticsRefreshQueue();
      expect(mocks.Queue).toHaveBeenCalledWith("analytics-refresh", {
        connection: expect.objectContaining({
          host: "queue-host",
          port: 6382,
          password: "queue-password",
          commandTimeout: 5_000,
        }),
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("runAnalyticsRefreshJobs", () => {
  function createQueue() {
    return {
      name: "analytics-refresh",
      add: vi.fn().mockResolvedValue(undefined),
      setGlobalConcurrency: vi.fn().mockResolvedValue(undefined),
      upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("serializes scheduled and immediate requests and permits another pending batch during a build", async () => {
    const controller = new AbortController();
    const queue = {
      name: "analytics-refresh",
      add: vi.fn().mockResolvedValue(undefined),
      setGlobalConcurrency: vi.fn().mockResolvedValue(undefined),
      upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
    };
    const processRefresh = vi.fn().mockResolvedValue(undefined);
    const reportFailure = vi.fn();
    const removeDeduplicationKey = vi.fn().mockResolvedValue(true);
    mocks.run.mockImplementation(async () => {
      const processor = mocks.Worker.mock.calls[0]?.[1];
      await processor({ removeDeduplicationKey });
      controller.abort();
    });

    await runAnalyticsRefreshJobs({
      queue,
      connection: { host: "redis" },
      processRefresh,
      intervalMilliseconds: 900_000,
      reportFailure,
      signal: controller.signal,
    });

    expect(queue.setGlobalConcurrency).toHaveBeenCalledWith(1);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      "analytics-refresh-periodic",
      { every: 900_000 },
      expect.objectContaining({ name: "analytics-refresh-periodic" }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      "analytics-refresh",
      { type: "analytics-refresh" },
      expect.objectContaining({ deduplication: { id: "analytics-refresh" } }),
    );
    expect(mocks.Worker).toHaveBeenCalledWith("analytics-refresh", expect.any(Function), {
      connection: { host: "redis" },
      concurrency: 1,
      autorun: false,
    });
    expect(removeDeduplicationKey).toHaveBeenCalledOnce();
    expect(removeDeduplicationKey.mock.invocationCallOrder[0]).toBeLessThan(
      processRefresh.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.on).toHaveBeenCalledWith("error", reportFailure);
    expect(processRefresh).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("routes periodic maintenance through the same combined refresh request", async () => {
    const controller = new AbortController();
    const queue = createQueue();
    const processRefresh = vi.fn().mockResolvedValue(undefined);
    mocks.run.mockImplementation(async () => {
      const processor = mocks.Worker.mock.calls[0]?.[1];
      await processor({ name: "analytics-refresh-periodic" });
      controller.abort();
    });
    await runAnalyticsRefreshJobs({
      queue,
      connection: { host: "redis" },
      processRefresh,
      intervalMilliseconds: 900_000,
      reportFailure: vi.fn(),
      signal: controller.signal,
    });
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(processRefresh).not.toHaveBeenCalled();
  });

  it("reports queue job failures and closes the consumer when its run fails", async () => {
    const failure = new Error("Redis consumer failed");
    const reportFailure = vi.fn();
    mocks.run.mockRejectedValue(failure);
    await expect(
      runAnalyticsRefreshJobs({
        queue: createQueue(),
        connection: { host: "redis" },
        processRefresh: vi.fn(),
        intervalMilliseconds: 900_000,
        reportFailure,
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(failure);
    const failed = mocks.on.mock.calls.find(([event]) => event === "failed")?.[1];
    failed(undefined, failure);
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith(failure);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("does not report the expected shutdown interruption as another queue failure", async () => {
    const controller = new AbortController();
    mocks.run.mockImplementation(async () => {
      controller.abort();
    });
    const reportFailure = vi.fn();
    await runAnalyticsRefreshJobs({
      queue: createQueue(),
      connection: { host: "redis" },
      processRefresh: vi.fn(),
      intervalMilliseconds: 900000,
      reportFailure,
      signal: controller.signal,
    });
    const failed = mocks.on.mock.calls.find(([event]) => event === "failed")?.[1];
    failed(
      undefined,
      new DOMException("Analytics refresh aborted before completion", "AbortError"),
    );
    expect(reportFailure).not.toHaveBeenCalled();
    const unexpected = new Error("Redis lost");
    failed(undefined, unexpected);
    expect(reportFailure).toHaveBeenCalledExactlyOnceWith(unexpected);
  });

  it("does not start a consumer after shutdown was requested", async () => {
    const controller = new AbortController();
    controller.abort();
    const queue = createQueue();
    await runAnalyticsRefreshJobs({
      queue,
      connection: { host: "redis" },
      processRefresh: vi.fn(),
      intervalMilliseconds: 900_000,
      reportFailure: vi.fn(),
      signal: controller.signal,
    });
    expect(queue.setGlobalConcurrency).not.toHaveBeenCalled();
    expect(mocks.Worker).not.toHaveBeenCalled();
  });

  it("closes promptly if shutdown arrives while initializing the queue", async () => {
    const controller = new AbortController();
    const queue = createQueue();
    queue.add.mockImplementation(async () => controller.abort());
    mocks.run.mockImplementation(() => new Promise(() => {}));
    await runAnalyticsRefreshJobs({
      queue,
      connection: { host: "redis" },
      processRefresh: vi.fn(),
      intervalMilliseconds: 900_000,
      reportFailure: vi.fn(),
      signal: controller.signal,
    });
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Deferred promise was not initialized");
  };
  let reject: (error: Error) => void = () => {
    throw new Error("Deferred promise was not initialized");
  };
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function awaitedRefreshFixture() {
  mocks.ready.mockReset().mockResolvedValue({});
  mocks.finished.mockReset().mockResolvedValue(undefined);
  const queue = createAnalyticsRefreshQueue({ host: "redis" });
  const events = new QueueEvents("analytics-refresh", { connection: { host: "redis" } });
  const job = new Job(queue, "analytics-refresh", { type: "analytics-refresh" });
  mocks.add.mockReset().mockResolvedValue(job);
  const controller = new AbortController();
  const added = vi.spyOn(controller.signal, "addEventListener");
  const removed = vi.spyOn(controller.signal, "removeEventListener");
  const run = () => enqueueAnalyticsRefreshAndWait(queue, events, controller.signal);
  const expectListenerReleased = () => {
    expect(added).toHaveBeenCalledExactlyOnceWith("abort", expect.any(Function), { once: true });
    expect(removed).toHaveBeenCalledExactlyOnceWith("abort", added.mock.calls[0]?.[1]);
  };
  return { queue, events, job, controller, run, added, removed, expectListenerReleased };
}

describe("enqueueAnalyticsRefreshAndWait cancellation", () => {
  it("rejects an already-aborted request before starting readiness or enqueue", async () => {
    const fixture = awaitedRefreshFixture();
    const reason = new Error("Worker stopped before dispatch");
    fixture.controller.abort(reason);
    await expect(fixture.run()).rejects.toBe(reason);
    expect(mocks.ready).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.finished).not.toHaveBeenCalled();
    expect(fixture.added).not.toHaveBeenCalled();
    expect(fixture.removed).not.toHaveBeenCalled();
  });

  it("cancels immediately during event readiness and never enqueues when readiness later resolves", async () => {
    const fixture = awaitedRefreshFixture();
    const ready = deferred<object>();
    mocks.ready.mockReturnValue(ready.promise);
    const pending = fixture.run();
    expect(mocks.ready).toHaveBeenCalledOnce();
    const reason = new Error("Worker shutdown during readiness");
    fixture.controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    fixture.expectListenerReleased();
    expect(mocks.add).not.toHaveBeenCalled();
    ready.resolve({});
    await ready.promise;
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.finished).not.toHaveBeenCalled();
  });

  it("cancels during enqueue and does not wait on a handle returned after shutdown", async () => {
    const fixture = awaitedRefreshFixture();
    const handle = deferred<typeof fixture.job>();
    const started = deferred<void>();
    mocks.add.mockImplementation(() => {
      started.resolve();
      return handle.promise;
    });
    const pending = fixture.run();
    await started.promise;
    const reason = new Error("Worker shutdown during enqueue");
    fixture.controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    fixture.expectListenerReleased();
    expect(mocks.add).toHaveBeenCalledOnce();
    handle.resolve(fixture.job);
    await handle.promise;
    expect(mocks.finished).not.toHaveBeenCalled();
  });

  it("cancels an unfinished job without acknowledging it and releases its abort listener", async () => {
    const fixture = awaitedRefreshFixture();
    const finish = deferred<void>();
    const started = deferred<void>();
    mocks.finished.mockImplementation(() => {
      started.resolve();
      return finish.promise;
    });
    let acknowledged = false;
    const pending = fixture.run().then(() => {
      acknowledged = true;
    });
    await started.promise;
    expect(acknowledged).toBe(false);
    const reason = new Error("Worker shutdown during refresh");
    fixture.controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(acknowledged).toBe(false);
    fixture.expectListenerReleased();
    finish.resolve();
    await finish.promise;
    expect(acknowledged).toBe(false);
  });

  it("waits for actual completion before acknowledging and releases the listener on success", async () => {
    const fixture = awaitedRefreshFixture();
    const finish = deferred<void>();
    const started = deferred<void>();
    mocks.finished.mockImplementation(() => {
      started.resolve();
      return finish.promise;
    });
    let acknowledged = false;
    const pending = fixture.run().then(() => {
      acknowledged = true;
    });
    await started.promise;
    expect(acknowledged).toBe(false);
    expect(mocks.finished).toHaveBeenCalledExactlyOnceWith(fixture.events);
    finish.resolve();
    await pending;
    expect(acknowledged).toBe(true);
    fixture.expectListenerReleased();
  });

  it.each(["readiness", "enqueue", "completion"] as const)(
    "propagates %s failure and releases the listener",
    async (stage) => {
      const fixture = awaitedRefreshFixture();
      const failure = new Error(`${stage} failed`);
      if (stage === "readiness") mocks.ready.mockRejectedValue(failure);
      else if (stage === "enqueue") mocks.add.mockRejectedValue(failure);
      else mocks.finished.mockRejectedValue(failure);
      await expect(fixture.run()).rejects.toBe(failure);
      fixture.expectListenerReleased();
      if (stage === "readiness") expect(mocks.add).not.toHaveBeenCalled();
      if (stage !== "completion") expect(mocks.finished).not.toHaveBeenCalled();
    },
  );
});
