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
const lifecycleDependencies = await workerLifecycleDependencies(queues, dependencies);
const lifecycle = createWorkerLifecycle(lifecycleDependencies);
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

    getWorkerHandler("failed")(
      { id: "stale-job", opts: {}, attemptsMade: 1 },
      new Error("stale stalled job"),
    );

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

describe("worker lifecycle direct state", () => {
  const firstWorker = queues.allWorkers[0];
  const secondWorker = queues.allWorkers[1];
  if (!firstWorker || !secondWorker) throw new Error("Worker fixtures missing");

  it("counts named and unnamed jobs together, deduplicates active events, and scopes IDs by queue", () => {
    const tracker = createWorkerLifecycle(lifecycleDependencies);
    expect(tracker.activeJobCount()).toBe(0);
    tracker.trackActiveJob(firstWorker, { id: "shared-id" });
    tracker.trackActiveJob(firstWorker, { id: "shared-id" });
    tracker.trackActiveJob(secondWorker, { id: "shared-id" });
    tracker.trackActiveJob(firstWorker, undefined);
    expect(tracker.activeJobCount()).toBe(3);

    tracker.finishActiveJob(firstWorker, { id: "shared-id" });
    expect(tracker.activeJobCount()).toBe(2);
    tracker.finishActiveJob(firstWorker, { id: "stale-id" });
    expect(tracker.activeJobCount()).toBe(2);
    tracker.finishActiveJob(secondWorker, { id: "shared-id" });
    expect(tracker.activeJobCount()).toBe(1);
    tracker.finishActiveJob(firstWorker, undefined);
    expect(tracker.activeJobCount()).toBe(0);
  });

  it("never decrements unnamed active jobs below zero after unmatched completion events", () => {
    const tracker = createWorkerLifecycle(lifecycleDependencies);
    tracker.finishActiveJob(firstWorker, undefined);
    expect(tracker.activeJobCount()).toBe(0);
    tracker.trackActiveJob(firstWorker, {});
    expect(tracker.activeJobCount()).toBe(1);
    tracker.finishActiveJob(firstWorker, {});
    expect(tracker.activeJobCount()).toBe(0);
    tracker.finishActiveJob(firstWorker, {});
    expect(tracker.activeJobCount()).toBe(0);
  });

  it("tracks numeric zero IDs as named jobs and ignores their repeated active events", () => {
    const tracker = createWorkerLifecycle(lifecycleDependencies);
    tracker.trackActiveJob(firstWorker, { id: 0 });
    tracker.trackActiveJob(firstWorker, { id: 0 });
    expect(tracker.activeJobCount()).toBe(1);
    tracker.finishActiveJob(firstWorker, { id: 0 });
    expect(tracker.activeJobCount()).toBe(0);
  });

  it("clears only scheduled idle timers and replaces them with a fresh five-minute deadline", async () => {
    // Reevaluate the module constant under the active mutation, rather than
    // retaining the value from this test file's initial static import.
    vi.resetModules();
    const { createWorkerLifecycle: createFreshWorkerLifecycle } = await import(
      "./worker-lifecycle.ts"
    );
    const timerLifecycle = createFreshWorkerLifecycle(lifecycleDependencies);
    const clearCount = clearTimeoutSpy.mock.calls.length;
    timerLifecycle.resetIdleTimer();
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(clearCount);

    timerLifecycle.startIdleTimer();
    const firstTimer = setTimeoutSpy.mock.results.at(-1)?.value;
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 300_000);
    timerLifecycle.startIdleTimer();
    const secondTimer = setTimeoutSpy.mock.results.at(-1)?.value;
    expect(clearTimeoutSpy).toHaveBeenLastCalledWith(firstTimer);
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 300_000);
    timerLifecycle.resetIdleTimer();
    expect(clearTimeoutSpy).toHaveBeenLastCalledWith(secondTimer);
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(clearCount + 2);
    timerLifecycle.resetIdleTimer();
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(clearCount + 2);
  });

  it("drains resources and exits successfully when the five-minute idle callback fires", async () => {
    const timerLifecycle = createWorkerLifecycle(lifecycleDependencies);
    const exitCount = exitSpy.mock.calls.length;
    const closeCount = mockClose.mock.calls.length;
    timerLifecycle.startIdleTimer();
    const callback = setTimeoutSpy.mock.calls.at(-1)?.[0];
    expect(callback).toBeTypeOf("function");
    if (typeof callback !== "function") throw new Error("Idle callback missing");
    timerLifecycle.resetIdleTimer();

    await expect(Reflect.apply(callback, undefined, [])).rejects.toThrow(
      "process.exit called unexpectedly in test",
    );

    const { logger } = await import("../logger.ts");
    expect(logger.info).toHaveBeenCalledWith("[worker] Idle timeout reached, shutting down...");
    expect(mockClose).toHaveBeenCalledTimes(closeCount + EXPECTED_WORKER_COUNT);
    expect(exitSpy).toHaveBeenCalledTimes(exitCount + 1);
    expect(exitSpy).toHaveBeenLastCalledWith(0);
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
