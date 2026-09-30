import "./worker-test/test-helpers.ts";
import { describe, expect, it, vi } from "vitest";
import { attachWorkerEvents } from "./worker-events.ts";
import { createWorkerLifecycle } from "./worker-lifecycle.ts";
import { createWorkerQueues } from "./worker-queues.ts";
import {
  clearTimeoutSpy,
  EXPECTED_WORKER_COUNT,
  exitSpy,
  getWorkerHandler,
  hoisted,
  mockClose,
  mockCloseAccountErasureOutbox,
  mockCloseAccountErasureRuntime,
  mockCloseAccountErasureWorkLockPool,
  mockCloseDataExportOutbox,
  mockCloseGarminProgress,
  mockCloseProviderDataDeletionOutbox,
  mockReadinessClose,
  setTimeoutSpy,
  workerLifecycleDependencies,
  workerQueueDependencies,
} from "./worker-test/test-helpers.ts";

const dependencies = await workerQueueDependencies();
const queues = createWorkerQueues(dependencies);
const lifecycle = createWorkerLifecycle(await workerLifecycleDependencies(queues, dependencies));
attachWorkerEvents(
  queues.allWorkers,
  lifecycle,
  dependencies.db,
  queues.providerDataDeletionWorker,
);
lifecycle.startIdleTimer();
lifecycle.registerProcessHandlers();
describe("worker lifecycle", () => {
  it("registers SIGTERM and SIGINT handlers", () => {
    const signalListeners = process.listeners("SIGTERM");
    expect(signalListeners.length).toBeGreaterThan(0);
  });

  it("does not actually exit", () => {
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("starts idle timer at init (setTimeout called)", () => {
    // Module init calls startIdleTimer() which calls setTimeout
    expect(setTimeoutSpy).toHaveBeenCalled();
  });

  it("active event handler resets idle timer without starting a new one", () => {
    const clearBefore = clearTimeoutSpy.mock.calls.length;
    const setTimeoutBefore = setTimeoutSpy.mock.calls.length;

    getWorkerHandler("active")();

    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(clearBefore);
    expect(setTimeoutSpy.mock.calls.length).toBe(setTimeoutBefore);
    getWorkerHandler("completed")();
  });

  it("completed event handler restarts idle timer when no active jobs", () => {
    getWorkerHandler("active")();
    const setTimeoutBefore = setTimeoutSpy.mock.calls.length;

    getWorkerHandler("completed")();

    expect(setTimeoutSpy.mock.calls.length).toBeGreaterThan(setTimeoutBefore);
  });

  it("completed event handler does not restart idle timer while another job is active", () => {
    getWorkerHandler("active")();
    getWorkerHandler("active")();
    const setTimeoutBefore = setTimeoutSpy.mock.calls.length;

    getWorkerHandler("completed")();

    expect(setTimeoutSpy.mock.calls.length).toBe(setTimeoutBefore);
    getWorkerHandler("completed")();
  });

  it("failed event handler does not restart idle timer while another job is active", async () => {
    const Sentry = await import("@sentry/node");
    vi.mocked(Sentry.captureException).mockClear();
    getWorkerHandler("active")();
    getWorkerHandler("active")();
    const setTimeoutBefore = setTimeoutSpy.mock.calls.length;

    getWorkerHandler("failed")(undefined, new Error("one of two jobs failed"));

    expect(Sentry.captureException).toHaveBeenCalledOnce();
    expect(setTimeoutSpy.mock.calls.length).toBe(setTimeoutBefore);
    getWorkerHandler("completed")();
  });

  it("failed event handler ignores stale failed jobs for idle accounting", async () => {
    const Sentry = await import("@sentry/node");
    vi.mocked(Sentry.captureException).mockClear();
    getWorkerHandler("active")({ id: "active-job" });
    const setTimeoutBefore = setTimeoutSpy.mock.calls.length;

    getWorkerHandler("failed")({ id: "stale-job" }, new Error("stale stalled job"));

    expect(Sentry.captureException).toHaveBeenCalledOnce();
    expect(setTimeoutSpy.mock.calls.length).toBe(setTimeoutBefore);
    getWorkerHandler("completed")({ id: "active-job" });
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
});
