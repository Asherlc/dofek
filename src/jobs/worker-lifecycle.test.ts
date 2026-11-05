import "./worker-test/test-helpers.ts";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const closePublishers = vi.hoisted(() => vi.fn(async (): Promise<void> => undefined));
vi.mock("../metric-stream/pulsar-producer.ts", () => ({
  closeAllMetricStreamEventPublishers: closePublishers,
}));

import { createWorkerLifecycle } from "./worker-lifecycle.ts";
import { createWorkerQueues } from "./worker-queues.ts";
import {
  EXPECTED_WORKER_COUNT,
  exitSpy,
  hoisted,
  mockClose,
  mockCloseAccountErasureOutbox,
  mockCloseAccountErasureRuntime,
  mockCloseAccountErasureWorkLockPool,
  mockCloseDataExportOutbox,
  mockCloseGarminProgress,
  mockCloseProviderDataDeletionOutbox,
  mockReadinessClose,
  workerLifecycleDependencies,
  workerQueueDependencies,
} from "./worker-test/test-helpers.ts";

const dependencies = await workerQueueDependencies();
const queues = createWorkerQueues(dependencies);
const lifecycleDependencies = await workerLifecycleDependencies(queues, dependencies);
const lifecycle = createWorkerLifecycle(lifecycleDependencies);
lifecycle.registerProcessHandlers();
describe("worker lifecycle", () => {
  it.each(["SIGTERM", "SIGINT"] as const)("registers graceful shutdown for %s", (signal) => {
    expect(process.listeners(signal).at(-1)).toBeTypeOf("function");
  });

  it("unhandledRejection handler reports to Sentry and logs", async () => {
    const Sentry = await import("@sentry/node");
    const { logger } = await import("../logger.ts");
    vi.mocked(Sentry.captureException).mockClear();
    vi.mocked(logger.error).mockClear();

    const handlers = process.listeners("unhandledRejection");
    const handler = handlers[handlers.length - 1];
    expect(handler).toBeDefined();
    const error = new Error("test unhandled");
    handler?.(error, Promise.resolve());

    expect(Sentry.captureException).toHaveBeenCalledWith(error);
    expect(logger.error).toHaveBeenCalled();
  });

  it("closes readiness and Garmin progress resources during graceful shutdown", async () => {
    const { closeAllQueueResources, closeAnalyticsRefreshWaiters } = await import("./queues.ts");
    const shutdownOrder: string[] = [];
    vi.mocked(closeAnalyticsRefreshWaiters).mockImplementation(async () => {
      shutdownOrder.push("refresh waiters");
    });
    mockClose.mockImplementation(async () => {
      shutdownOrder.push("worker");
    });
    mockCloseGarminProgress.mockImplementation(async () => {
      shutdownOrder.push("Garmin progress");
    });
    closePublishers.mockImplementation(async () => {
      shutdownOrder.push("publishers");
    });
    const signalHandler = process.listeners("SIGTERM").at(-1);
    if (!signalHandler) {
      throw new Error("SIGTERM handler was not registered");
    }

    exitSpy.mockImplementationOnce(vi.fn<typeof process.exit>());
    Reflect.apply(signalHandler, process, []);
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));

    expect(mockReadinessClose).toHaveBeenCalledOnce();
    expect(mockCloseGarminProgress).toHaveBeenCalledOnce();
    expect(mockCloseAccountErasureOutbox).toHaveBeenCalledOnce();
    expect(mockCloseAccountErasureRuntime).toHaveBeenCalledOnce();
    expect(mockCloseAccountErasureWorkLockPool).toHaveBeenCalledOnce();
    expect(mockCloseProviderDataDeletionOutbox).toHaveBeenCalledOnce();
    expect(mockCloseDataExportOutbox).toHaveBeenCalledOnce();
    expect(hoisted.mockCloseFileUploadOutbox).toHaveBeenCalledOnce();
    expect(hoisted.mockCloseFileUploadReconciler).toHaveBeenCalledOnce();
    expect(mockClose).toHaveBeenCalledTimes(EXPECTED_WORKER_COUNT);
    expect(closeAllQueueResources).toHaveBeenCalledOnce();
    expect(shutdownOrder).toEqual([
      "refresh waiters",
      ...Array.from({ length: EXPECTED_WORKER_COUNT }, () => "worker"),
      "publishers",
      "Garmin progress",
    ]);
  });

  it("drains exactly once when shutdown is requested again during and after the first drain", async () => {
    const drainLifecycle = createWorkerLifecycle(lifecycleDependencies);
    const workerCloseCount = mockClose.mock.calls.length;
    const readinessCloseCount = mockReadinessClose.mock.calls.length;
    const exitCount = exitSpy.mock.calls.length;
    let finishDrain = () => {};
    const pendingClose = new Promise<void>((resolve) => {
      finishDrain = resolve;
    });
    mockClose.mockImplementationOnce(() => pendingClose);
    const firstShutdown = drainLifecycle.shutdown();
    const firstShutdownAssertion = expect(firstShutdown).rejects.toThrow(
      "process.exit called unexpectedly in test",
    );

    await expect(drainLifecycle.shutdown()).resolves.toBeUndefined();
    expect(mockClose).toHaveBeenCalledTimes(workerCloseCount + EXPECTED_WORKER_COUNT);
    expect(mockReadinessClose).toHaveBeenCalledTimes(readinessCloseCount + 1);
    expect(exitSpy).toHaveBeenCalledTimes(exitCount);

    finishDrain();
    await firstShutdownAssertion;
    await expect(drainLifecycle.shutdown()).resolves.toBeUndefined();
    expect(mockClose).toHaveBeenCalledTimes(workerCloseCount + EXPECTED_WORKER_COUNT);
    expect(exitSpy).toHaveBeenCalledTimes(exitCount + 1);
  });

  it("propagates readiness closure errors before closing dependent queues or the database", async () => {
    const drainLifecycle = createWorkerLifecycle(lifecycleDependencies);
    const { closeAllQueueResources } = await import("./queues.ts");
    const queueCloseCount = vi.mocked(closeAllQueueResources).mock.calls.length;
    const databaseCloseCount = hoisted.mockDatabase.$client.end.mock.calls.length;
    const exitCount = exitSpy.mock.calls.length;
    const error = new Error("Readiness server close failed");
    mockReadinessClose.mockImplementationOnce((callback) => callback(error));

    await expect(drainLifecycle.shutdown()).rejects.toBe(error);

    expect(closeAllQueueResources).toHaveBeenCalledTimes(queueCloseCount);
    expect(hoisted.mockDatabase.$client.end).toHaveBeenCalledTimes(databaseCloseCount);
    expect(exitSpy).toHaveBeenCalledTimes(exitCount);
  });

  it("does not close publishers until all workers finish, then waits before closing pools", async () => {
    const drainLifecycle = createWorkerLifecycle(lifecycleDependencies);
    let finishWorker = () => {};
    let finishPublishers = () => {};
    const worker = new Promise<void>((resolve) => {
      finishWorker = resolve;
    });
    const publishers = new Promise<void>((resolve) => {
      finishPublishers = resolve;
    });
    mockClose.mockImplementationOnce(() => worker);
    closePublishers.mockClear().mockImplementationOnce(() => publishers);
    const poolCloses = mockCloseAccountErasureWorkLockPool.mock.calls.length;
    const outcome = expect(drainLifecycle.shutdown()).rejects.toThrow(
      "process.exit called unexpectedly in test",
    );
    await vi.waitFor(() => expect(mockClose).toHaveBeenCalled());
    expect(closePublishers).not.toHaveBeenCalled();
    finishWorker();
    await vi.waitFor(() => expect(closePublishers).toHaveBeenCalledOnce());
    expect(mockCloseAccountErasureWorkLockPool).toHaveBeenCalledTimes(poolCloses);
    finishPublishers();
    await outcome;
  });

  it("propagates publisher cleanup failure without success exit", async () => {
    const drainLifecycle = createWorkerLifecycle(lifecycleDependencies);
    const error = new Error("publisher cleanup failed");
    closePublishers.mockRejectedValueOnce(error);
    const exits = exitSpy.mock.calls.length;
    await expect(drainLifecycle.shutdown()).rejects.toBe(error);
    expect(exitSpy).toHaveBeenCalledTimes(exits);
  });

  it.each(["SIGTERM", "SIGINT"] as const)(
    "exits nonzero when publisher cleanup fails through registered %s dispatch",
    async (signal) => {
      const signals = new EventEmitter();
      const unhandled: unknown[] = [];
      const registration = vi.spyOn(process, "on").mockImplementation((event, listener) => {
        signals.on(event, (...args: unknown[]) => {
          const result: unknown = Reflect.apply(listener, process, args);
          if (result instanceof Promise)
            void result.then(undefined, (error) => {
              unhandled.push(error);
            });
        });
        return process;
      });
      try {
        createWorkerLifecycle(lifecycleDependencies).registerProcessHandlers();
      } finally {
        registration.mockRestore();
      }
      const Sentry = await import("@sentry/node");
      const { logger } = await import("../logger.ts");
      const error = new Error("publisher signal cleanup failed");
      closePublishers.mockRejectedValueOnce(error);
      exitSpy.mockClear().mockImplementationOnce(vi.fn<typeof process.exit>());
      signals.emit(signal);
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
      expect(exitSpy.mock.calls).toEqual([[1]]);
      expect(Sentry.captureException).toHaveBeenCalledWith(
        error,
        expect.objectContaining({ tags: { context: "worker-shutdown" } }),
      );
      expect(logger.error).toHaveBeenCalledWith(
        "[worker] Graceful shutdown failed; exiting with failure",
      );
      expect(unhandled).toEqual([]);
    },
  );
});
