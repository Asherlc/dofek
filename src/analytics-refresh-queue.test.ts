import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  run: vi.fn(),
  Worker: vi.fn(),
  Queue: vi.fn(),
  add: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("bullmq", () => ({
  Worker: mocks.Worker,
  Queue: mocks.Queue,
  QueueEvents: vi.fn(),
  FlowProducer: vi.fn(),
  RedisConnection: vi.fn(),
}));

import {
  createAnalyticsRefreshQueue,
  enqueueAnalyticsRefresh,
  runAnalyticsRefreshJobs,
} from "./analytics-refresh-queue.ts";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.Worker.mockImplementation(function vitestConstructor() {
    return { close: mocks.close, on: mocks.on, run: mocks.run };
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
        removeOnComplete: true,
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
