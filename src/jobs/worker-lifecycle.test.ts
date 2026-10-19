import "./worker-test/test-helpers.ts";
import { describe, expect, it, vi } from "vitest";
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
    expect(process.listeners(signal)).toContain(lifecycle.shutdown);
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
    const { closeAllQueueResources } = await import("./queues.ts");
    const shutdownOrder: string[] = [];
    mockClose.mockImplementation(async () => {
      shutdownOrder.push("worker");
    });
    mockCloseGarminProgress.mockImplementation(async () => {
      shutdownOrder.push("Garmin progress");
    });
    const signalHandler = process.listeners("SIGTERM").at(-1);
    if (!signalHandler) {
      throw new Error("SIGTERM handler was not registered");
    }

    const shutdownResult: unknown = Reflect.apply(signalHandler, process, []);
    if (!(shutdownResult instanceof Promise)) {
      throw new Error("SIGTERM handler did not return its shutdown promise");
    }
    await expect(shutdownResult).rejects.toThrow("process.exit called unexpectedly in test");

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
      ...Array.from({ length: EXPECTED_WORKER_COUNT }, () => "worker"),
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
});
