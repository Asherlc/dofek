import "./worker-test/test-helpers.ts";
import { describe, expect, it, vi } from "vitest";
import {
  EXPECTED_WORKER_COUNT,
  hoisted,
  invokeProcessor,
  mockClickHouseClient,
  mockDatabase,
  mockObserveFitJob,
  mockOn,
  mockReadinessListen,
  mockReconcileGarminProgress,
  mockRun,
  reconcileGarminProgressError,
} from "./worker-test/test-helpers.ts";
import "./worker.ts";

describe("worker startup", () => {
  it("reconciles external deletion intents before creating any queue worker", async () => {
    const { Worker } = await import("bullmq");
    expect(hoisted.mockValidateAccountErasureLedgerKeyring).toHaveBeenCalledOnce();
    expect(hoisted.mockReconcileAccountErasureRestoreIntents).toHaveBeenCalledWith(
      expect.objectContaining({
        database: mockDatabase,
        ledger: hoisted.mockAccountErasureRestoreLedger,
      }),
    );
    const reconciliationOrder =
      hoisted.mockReconcileAccountErasureRestoreIntents.mock.invocationCallOrder[0];
    const firstWorkerOrder = vi.mocked(Worker).mock.invocationCallOrder[0];
    expect(reconciliationOrder).toBeDefined();
    expect(firstWorkerOrder).toBeDefined();
    if (reconciliationOrder === undefined || firstWorkerOrder === undefined) {
      throw new Error("Startup invocation order was not recorded");
    }
    expect(reconciliationOrder).toBeLessThan(firstWorkerOrder);
  });

  it("initializes the durable erasure runtime before creating queue workers", async () => {
    const { Worker } = await import("bullmq");
    const { createAccountErasureRuntime } = await import("./account-erasure-runtime.ts");

    expect(createAccountErasureRuntime).toHaveBeenCalledWith(
      mockDatabase,
      mockClickHouseClient,
      hoisted.mockAccountErasureWorkPurger,
    );
    const runtimeOrder = hoisted.mockCreateAccountErasureRuntime.mock.invocationCallOrder[0];
    const firstWorkerOrder = vi.mocked(Worker).mock.invocationCallOrder[0];
    expect(runtimeOrder).toBeDefined();
    expect(firstWorkerOrder).toBeDefined();
    if (runtimeOrder === undefined || firstWorkerOrder === undefined) {
      throw new Error("Runtime startup invocation order was not recorded");
    }
    expect(runtimeOrder).toBeLessThan(firstWorkerOrder);
  });

  it("attaches worker handlers before workers start processing jobs", async () => {
    const { Worker } = await import("bullmq");
    const workerOptions = vi.mocked(Worker).mock.calls.map((workerCall) => workerCall[2]);
    expect(workerOptions).toHaveLength(EXPECTED_WORKER_COUNT);
    for (const options of workerOptions) {
      expect(options).toEqual(expect.objectContaining({ autorun: false }));
    }

    expect(mockRun).toHaveBeenCalledTimes(EXPECTED_WORKER_COUNT);
    const lastHandlerRegistration =
      mockOn.mock.invocationCallOrder[mockOn.mock.invocationCallOrder.length - 1];
    const firstWorkerRun = mockRun.mock.invocationCallOrder[0];
    expect(lastHandlerRegistration).toBeDefined();
    expect(firstWorkerRun).toBeDefined();
    if (lastHandlerRegistration === undefined || firstWorkerRun === undefined) {
      throw new Error("Worker startup order was not recorded");
    }
    expect(lastHandlerRegistration).toBeLessThan(firstWorkerRun);
  });

  it("serves readiness from the worker process after starting every queue worker", async () => {
    const { Worker } = await import("bullmq");
    const { createWorkerReadinessServer } = await import("./worker-readiness.ts");
    const workerInstances = vi.mocked(Worker).mock.results.map((result) => result.value);

    expect(createWorkerReadinessServer).toHaveBeenCalledWith(workerInstances);
    expect(mockReadinessListen).toHaveBeenCalledWith(3001, "127.0.0.1");
    const lastWorkerRun =
      mockRun.mock.invocationCallOrder[mockRun.mock.invocationCallOrder.length - 1];
    const readinessListen = mockReadinessListen.mock.invocationCallOrder[0];
    expect(lastWorkerRun).toBeDefined();
    expect(readinessListen).toBeDefined();
    if (lastWorkerRun === undefined || readinessListen === undefined) {
      throw new Error("Worker readiness startup order was not recorded");
    }
    expect(lastWorkerRun).toBeLessThan(readinessListen);
  });

  it("initializes Sentry and PostHog when DSN is set", async () => {
    const Sentry = await import("@sentry/node");
    const { initProductionPostHog } = await import("../lib/posthog.ts");
    expect(Sentry.init).toHaveBeenCalledWith({
      beforeSend: expect.any(Function),
      dsn: "https://test@sentry.io/123",
      environment: "production",
      skipOpenTelemetrySetup: true,
    });
    expect(initProductionPostHog).toHaveBeenCalledWith("dofek-worker");
  });

  it("registers standard handlers plus FIT progress observers", () => {
    expect(mockOn).toHaveBeenCalledTimes(6 * EXPECTED_WORKER_COUNT + 3);
    const events = mockOn.mock.calls.map((call) => String(call[0]));
    expect(events.filter((e: string) => e === "active")).toHaveLength(EXPECTED_WORKER_COUNT);
    expect(events.filter((e: string) => e === "completed")).toHaveLength(EXPECTED_WORKER_COUNT + 1);
    expect(events.filter((e: string) => e === "failed")).toHaveLength(EXPECTED_WORKER_COUNT + 2);
    expect(events.filter((e: string) => e === "stalled")).toHaveLength(EXPECTED_WORKER_COUNT);
    expect(events.filter((e: string) => e === "lockRenewalFailed")).toHaveLength(
      EXPECTED_WORKER_COUNT,
    );
    expect(events.filter((e: string) => e === "error")).toHaveLength(EXPECTED_WORKER_COUNT);
  });

  it("reports a durable Garmin progress reconciliation failure when the worker starts", async () => {
    const Sentry = await import("@sentry/node");
    const { logger } = await import("../logger.ts");

    expect(mockReconcileGarminProgress).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(Sentry.captureException).toHaveBeenCalledWith(reconcileGarminProgressError, {
        tags: { garminDumpStep: "progress-reconcile" },
      });
    });
    expect(logger.error).toHaveBeenCalledWith(
      "[worker] Failed to reconcile Garmin import progress: Error: progress Redis unavailable",
    );
  });

  it("starts export outbox recovery with the durable database row and export queue", async () => {
    const { startDataExportOutboxDispatcher } = await import("./data-export-outbox.ts");
    const { getDataExportQueue } = await import("./queues.ts");

    expect(startDataExportOutboxDispatcher).toHaveBeenCalledWith(
      mockDatabase,
      vi.mocked(getDataExportQueue).mock.results[0]?.value,
    );
  });

  it("starts account erasure outbox recovery with the durable request row", async () => {
    const { startAccountErasureOutboxDispatcher } = await import("./account-erasure-outbox.ts");
    const { getAccountErasureQueue } = await import("./queues.ts");

    expect(startAccountErasureOutboxDispatcher).toHaveBeenCalledWith(
      mockDatabase,
      vi.mocked(getAccountErasureQueue).mock.results[0]?.value,
    );
  });

  it("observes completed and failed FIT jobs for durable parent progress", () => {
    mockObserveFitJob.mockClear();
    const completedHandlers = mockOn.mock.calls.filter((mockCall) => mockCall[0] === "completed");
    const failedHandlers = mockOn.mock.calls.filter((mockCall) => mockCall[0] === "failed");
    const completedHandler = completedHandlers.at(-1)?.[1];
    const failedHandler = failedHandlers.at(-1)?.[1];
    if (typeof completedHandler !== "function" || typeof failedHandler !== "function") {
      throw new Error("FIT progress handlers were not registered");
    }
    const fitJob = { id: "fit-1", parent: { id: "batch-1", queueKey: "bull:fit-batch" } };

    completedHandler(fitJob);
    failedHandler(fitJob, new Error("invalid FIT"));
    failedHandler(undefined, new Error("missing FIT job"));

    expect(mockObserveFitJob).toHaveBeenNthCalledWith(1, fitJob);
    expect(mockObserveFitJob).toHaveBeenNthCalledWith(2, fitJob);
    expect(mockObserveFitJob).toHaveBeenCalledTimes(2);
  });

  it("post-sync processor passes cached ClickHouse helpers to processPostSyncJob", async () => {
    const { createClickHouseClientFromEnv } = await import("../db/clickhouse.ts");
    const { createRefitSensorStore } = await import("../db/refit-sensor-store.ts");
    const { refreshBodyMeasurementReadModel } = await import(
      "../db/clickhouse-read-model-refresh.ts"
    );
    const { processPostSyncJob } = await import("./process-post-sync-job.ts");
    vi.mocked(createRefitSensorStore).mockClear();
    vi.mocked(refreshBodyMeasurementReadModel).mockClear();
    vi.mocked(processPostSyncJob).mockClear();

    await invokeProcessor("post-sync-queue", { type: "user-refit", userId: "u" });
    const processCall = vi.mocked(processPostSyncJob).mock.calls[0];
    const getSensorStore = processCall?.[2];
    const refreshBodyMeasurements = processCall?.[3];
    expect(getSensorStore).toBeDefined();
    expect(refreshBodyMeasurements).toBeDefined();

    if (typeof getSensorStore !== "function" || typeof refreshBodyMeasurements !== "function") {
      throw new Error("post-sync helpers were not passed to processPostSyncJob");
    }

    getSensorStore();
    getSensorStore();
    await refreshBodyMeasurements();

    expect(createClickHouseClientFromEnv).toHaveBeenCalledOnce();
    expect(createRefitSensorStore).toHaveBeenCalledOnce();
    expect(refreshBodyMeasurementReadModel).toHaveBeenCalledOnce();
  });

  it("fails startup before registering sync when the interval is invalid", async () => {
    const previousSyncInterval = process.env.SYNC_INTERVAL_MINUTES;
    const workerRunCount = mockRun.mock.calls.length;
    const readinessListenCount = mockReadinessListen.mock.calls.length;
    process.env.SYNC_INTERVAL_MINUTES = "not-a-number";
    mockReconcileGarminProgress.mockResolvedValue(undefined);
    vi.resetModules();

    try {
      await expect(import("./worker.ts")).rejects.toThrow(
        'SYNC_INTERVAL_MINUTES must be a finite positive number, received "not-a-number"',
      );
    } finally {
      if (previousSyncInterval === undefined) {
        delete process.env.SYNC_INTERVAL_MINUTES;
      } else {
        process.env.SYNC_INTERVAL_MINUTES = previousSyncInterval;
      }
    }

    expect(mockRun).toHaveBeenCalledTimes(workerRunCount);
    expect(mockReadinessListen).toHaveBeenCalledTimes(readinessListenCount);
  });

  it("fails startup before running workers or exposing readiness when scheduler registration fails", async () => {
    const registrationError = new Error("scheduler Redis command failed");
    const workerRunCount = mockRun.mock.calls.length;
    const readinessListenCount = mockReadinessListen.mock.calls.length;
    hoisted.scheduledSyncState.error = registrationError;
    mockReconcileGarminProgress.mockResolvedValue(undefined);
    vi.resetModules();

    await expect(import("./worker.ts")).rejects.toBe(registrationError);

    const Sentry = await import("@sentry/node");
    const { logger } = await import("../logger.ts");
    expect(Sentry.captureException).toHaveBeenCalledWith(registrationError, {
      tags: { workerStartupStep: "scheduledSyncRegistration" },
    });
    expect(logger.error).toHaveBeenCalledWith("[worker] Failed to set up scheduled sync", {
      error: registrationError,
      errorStack: registrationError.stack,
    });
    expect(mockRun).toHaveBeenCalledTimes(workerRunCount);
    expect(mockReadinessListen).toHaveBeenCalledTimes(readinessListenCount);
  });
});
