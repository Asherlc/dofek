import "./worker-test/test-helpers.ts";
import { describe, expect, it, vi } from "vitest";
import { createWorkerQueues } from "./worker-queues.ts";
import {
  EXPECTED_WORKER_COUNT,
  hoisted,
  invokeProcessor,
  mockAddJobLog,
  mockClickHouseClient,
  mockDatabase,
  processorArity,
  workerProcessors,
  workerQueueDependencies,
} from "./worker-test/test-helpers.ts";

const dependencies = await workerQueueDependencies();
createWorkerQueues(dependencies);
describe("worker queues", () => {
  it("creates per-provider workers plus standard workers", async () => {
    const { Worker } = await import("bullmq");
    expect(Worker).toHaveBeenCalledTimes(EXPECTED_WORKER_COUNT);
    // Per-provider workers
    expect(Worker).toHaveBeenCalledWith("sync-strava", expect.any(Function), expect.any(Object));
    expect(Worker).toHaveBeenCalledWith("sync-garmin", expect.any(Function), expect.any(Object));
    // Legacy sync worker
    expect(Worker).toHaveBeenCalledWith("sync-queue", expect.any(Function), expect.any(Object));
    // Standard workers
    expect(Worker).toHaveBeenCalledWith("import-queue", expect.any(Function), expect.any(Object));
    expect(Worker).toHaveBeenCalledWith(
      "fit-file-import-queue",
      expect.any(Function),
      expect.objectContaining({ concurrency: 2 }),
    );
    expect(Worker).toHaveBeenCalledWith(
      "fit-file-import-batch-queue",
      expect.any(Function),
      expect.objectContaining({ concurrency: 1 }),
    );
    expect(Worker).toHaveBeenCalledWith(
      "zip-entry-extract-queue",
      expect.any(Function),
      expect.objectContaining({ concurrency: 2 }),
    );
    expect(Worker).toHaveBeenCalledWith("export-queue", expect.any(Function), expect.any(Object));
    expect(Worker).toHaveBeenCalledWith(
      "scheduled-sync-queue",
      expect.any(Function),
      expect.any(Object),
    );
    expect(Worker).toHaveBeenCalledWith(
      "post-sync-queue",
      expect.any(Function),
      expect.any(Object),
    );
    expect(Worker).toHaveBeenCalledWith(
      "activity-delete-analytics-queue",
      expect.any(Function),
      expect.objectContaining({ concurrency: 1 }),
    );
    expect(Worker).toHaveBeenCalledWith(
      "provider-data-deletion-queue",
      expect.any(Function),
      expect.objectContaining({ concurrency: 1 }),
    );
    expect(Worker).toHaveBeenCalledWith(
      "account-erasure-queue",
      expect.any(Function),
      expect.objectContaining({ concurrency: 1 }),
    );
  });

  it("rejects invalid provider deletion jobs at the Redis boundary", () => {
    const processor = workerProcessors["provider-data-deletion-queue"];
    if (!processor) throw new Error("provider deletion processor was not registered");
    const data = {
      type: "provider-data-deletion",
      eventId: "10000000-0000-4000-8000-000000000001",
      generation: 2,
      providerId: "garmin",
      userId: "20000000-0000-4000-8000-000000000002",
      checkpoint: {
        batches: 1,
        deletedRows: 10_000,
        lastId: "30000000-0000-4000-8000-000000000003",
      },
    };
    const invalidJob = {
      data: { ...data, generation: "2" },
      updateData: vi.fn(async () => undefined),
      updateProgress: vi.fn(async () => undefined),
    };

    expect(() => processor(invalidJob)).toThrow(hoisted.MockUnrecoverableError);
  });

  it("passes limiter config to per-provider workers", async () => {
    const { Worker } = await import("bullmq");
    expect(Worker).toHaveBeenCalledWith(
      "sync-strava",
      expect.any(Function),
      expect.objectContaining({ limiter: { max: 10, duration: 1000 } }),
    );
  });

  it("registers sync processors with BullMQ's cancellation-signal arity", async () => {
    expect(await processorArity("sync-strava")).toBeGreaterThanOrEqual(3);
    expect(await processorArity("sync-queue")).toBeGreaterThanOrEqual(3);
  });

  it("per-provider sync processor delegates to processSyncJob with cancellation", async () => {
    const { processSyncJob } = await import("./process-sync-job.ts");
    vi.mocked(processSyncJob).mockClear();
    const signal = new AbortController().signal;

    await invokeProcessor(
      "sync-strava",
      { providerId: "strava", userId: "user-1" },
      undefined,
      undefined,
      signal,
    );

    expect(processSyncJob).toHaveBeenCalledWith(expect.any(Object), mockDatabase, signal);
  });

  it("shared sync processor delegates to processSyncJob with cancellation", async () => {
    const { processSyncJob } = await import("./process-sync-job.ts");
    vi.mocked(processSyncJob).mockClear();
    const signal = new AbortController().signal;

    await invokeProcessor(
      "sync-queue",
      { providerId: "wahoo", userId: "user-1" },
      undefined,
      undefined,
      signal,
    );

    expect(processSyncJob).toHaveBeenCalledWith(expect.any(Object), mockDatabase, signal);
  });

  it("reports the coordinator waiting transition and rethrows BullMQ control flow", async () => {
    const { WaitingChildrenError } = await import("bullmq");
    const { processSyncJob } = await import("./process-sync-job.ts");
    const error = new WaitingChildrenError();
    dependencies.onSyncWaitingChildren.mockClear();
    vi.mocked(processSyncJob).mockRejectedValueOnce(error);
    await expect(invokeProcessor("sync-queue", { userId: "user-1" })).rejects.toBe(error);
    expect(dependencies.onSyncWaitingChildren).toHaveBeenCalledOnce();
    expect(dependencies.onSyncWaitingChildren).toHaveBeenCalledWith(
      expect.objectContaining({ name: "sync-queue" }),
      expect.objectContaining({ id: "test-job-1" }),
    );
  });

  it("keeps ordinary sync failures active until BullMQ reports the failed event", async () => {
    const { processSyncJob } = await import("./process-sync-job.ts");
    const error = new Error("Provider dispatch failed");
    dependencies.onSyncWaitingChildren.mockClear();
    vi.mocked(processSyncJob).mockRejectedValueOnce(error);
    await expect(invokeProcessor("sync-queue", { userId: "user-1" })).rejects.toBe(error);
    expect(dependencies.onSyncWaitingChildren).not.toHaveBeenCalled();
  });

  it("import processor delegates to processFileUploadImportJob", async () => {
    const { processFileUploadImportJob } = await import("./process-file-upload-import-job.ts");
    vi.mocked(processFileUploadImportJob).mockClear();
    hoisted.mockCreateImportUploadStorage.mockClear();

    await invokeProcessor("import-queue", {
      filePath: "/tmp/f",
      since: "2026-01-01",
      userId: "u",
      importType: "apple-health",
    });

    expect(processFileUploadImportJob).toHaveBeenCalled();
    expect(processFileUploadImportJob).toHaveBeenCalledWith(
      expect.any(Object),
      mockDatabase,
      hoisted.mockImportUploadStorage,
    );
    expect(hoisted.mockCreateImportUploadStorage).not.toHaveBeenCalled();
  });

  it("import processor fails loudly when BullMQ omits the job ID", async () => {
    const { processFileUploadImportJob } = await import("./process-file-upload-import-job.ts");
    vi.mocked(processFileUploadImportJob).mockClear();

    await expect(
      invokeProcessor(
        "import-queue",
        {
          filePath: "/tmp/f",
          since: "2026-01-01",
          userId: "u",
          importType: "garmin-dump",
        },
        "token-1",
        { id: undefined },
      ),
    ).rejects.toThrow("BullMQ import job ID missing");

    expect(processFileUploadImportJob).not.toHaveBeenCalled();
  });

  it("import processor passes a token-backed lock extender to processFileUploadImportJob", async () => {
    const { processFileUploadImportJob } = await import("./process-file-upload-import-job.ts");
    vi.mocked(processFileUploadImportJob).mockClear();
    const extendLock = vi.fn().mockResolvedValue(1);

    await invokeProcessor(
      "import-queue",
      {
        filePath: "/tmp/f",
        since: "2026-01-01",
        userId: "u",
        importType: "garmin-dump",
      },
      "token-1",
      { extendLock },
    );

    const processCall = vi.mocked(processFileUploadImportJob).mock.calls[0];
    const job = processCall?.[0];
    expect(job).toBeDefined();
    if (!job) {
      throw new Error("processFileUploadImportJob was not called");
    }

    await job.extendLock(600_000);

    expect(extendLock).toHaveBeenCalledWith("token-1", 600_000);
  });

  it("import processor exposes token-bound durable flow operations to processFileUploadImportJob", async () => {
    const { processFileUploadImportJob } = await import("./process-file-upload-import-job.ts");
    vi.mocked(processFileUploadImportJob).mockClear();
    const updateProgress = vi.fn().mockResolvedValue(undefined);
    const updateData = vi.fn().mockResolvedValue(undefined);
    const moveToWaitingChildren = vi.fn().mockResolvedValue(true);
    const getChildrenValues = vi.fn().mockResolvedValue({ "bull:fit-batch:batch-1": {} });
    const getIgnoredChildrenFailures = vi.fn().mockResolvedValue({});
    const nextData = {
      uploadId: "00000000-0000-4000-8000-0000000000f6",
      userId: "u",
      importType: "garmin-dump" as const,
      checkpoint: { version: 1 },
    };

    await invokeProcessor(
      "import-queue",
      {
        filePath: "/tmp/f",
        since: "2026-01-01",
        userId: "u",
        importType: "garmin-dump",
      },
      "token-1",
      {
        queueQualifiedName: "bull:import-queue",
        updateProgress,
        updateData,
        moveToWaitingChildren,
        getChildrenValues,
        getIgnoredChildrenFailures,
      },
    );

    const processCall = vi.mocked(processFileUploadImportJob).mock.calls[0];
    const durableJob = processCall?.[0];
    expect(durableJob).toBeDefined();
    if (!durableJob) {
      throw new Error("processFileUploadImportJob was not called");
    }

    expect(durableJob.id).toBe("test-job-1");
    expect(durableJob.queueQualifiedName).toBe("bull:import-queue");
    await durableJob.updateProgress({ percentage: 25 });
    await durableJob.updateData(nextData);
    await expect(durableJob.moveToWaitingChildren()).resolves.toBe(true);
    await expect(durableJob.getChildrenValues()).resolves.toEqual({
      "bull:fit-batch:batch-1": {},
    });
    await expect(durableJob.getIgnoredChildrenFailures()).resolves.toEqual({});
    mockAddJobLog.mockClear();
    await durableJob.log("[phase] prepared");

    expect(updateProgress).toHaveBeenCalledWith({ percentage: 25 });
    expect(updateData).toHaveBeenCalledWith(nextData);
    expect(moveToWaitingChildren).toHaveBeenCalledWith("token-1");
    expect(getChildrenValues).toHaveBeenCalledOnce();
    expect(getIgnoredChildrenFailures).toHaveBeenCalledOnce();
    expect(mockAddJobLog).toHaveBeenCalledWith(
      expect.objectContaining({ name: "import-queue" }),
      "test-job-1",
      "[phase] prepared",
      500,
    );
  });

  it("import processor lock extender fails loudly when BullMQ omits the token", async () => {
    const { processFileUploadImportJob } = await import("./process-file-upload-import-job.ts");
    vi.mocked(processFileUploadImportJob).mockClear();
    const extendLock = vi.fn().mockResolvedValue(1);

    await invokeProcessor(
      "import-queue",
      {
        filePath: "/tmp/f",
        since: "2026-01-01",
        userId: "u",
        importType: "garmin-dump",
      },
      undefined,
      { extendLock },
    );

    const processCall = vi.mocked(processFileUploadImportJob).mock.calls[0];
    const job = processCall?.[0];
    expect(job).toBeDefined();
    if (!job) {
      throw new Error("processFileUploadImportJob was not called");
    }

    await expect(job.extendLock(600_000)).rejects.toThrow("BullMQ import job lock token missing");
    expect(extendLock).not.toHaveBeenCalled();
  });

  it("import processor lock extender fails when BullMQ no longer owns the lock", async () => {
    const { processFileUploadImportJob } = await import("./process-file-upload-import-job.ts");
    vi.mocked(processFileUploadImportJob).mockClear();
    const extendLock = vi.fn().mockResolvedValue(0);

    await invokeProcessor(
      "import-queue",
      {
        filePath: "/tmp/f",
        since: "2026-01-01",
        userId: "u",
        importType: "garmin-dump",
      },
      "stale-token",
      { extendLock },
    );

    const processCall = vi.mocked(processFileUploadImportJob).mock.calls[0];
    const job = processCall?.[0];
    expect(job).toBeDefined();
    if (!job) {
      throw new Error("processFileUploadImportJob was not called");
    }

    await expect(job.extendLock(600_000)).rejects.toThrow(
      "BullMQ import job lock is no longer owned: test-job-1",
    );
    expect(extendLock).toHaveBeenCalledWith("stale-token", 600_000);
  });

  it("export processor delegates to processExportJob", async () => {
    const { processExportJob } = await import("./process-export-job.ts");
    vi.mocked(processExportJob).mockClear();

    await invokeProcessor("export-queue", { exportId: "export-1", userId: "u" });

    expect(processExportJob).toHaveBeenCalled();
  });

  it("FIT file import processor delegates to processFitFileImportJob", async () => {
    const { processFitFileImportJob } = await import("./process-fit-file-import-job.ts");
    vi.mocked(processFitFileImportJob).mockClear();

    await invokeProcessor("fit-file-import-queue", {
      filePath: "/tmp/activity.fit",
      originalPath: "activity.fit",
      userId: "u",
      providerId: "garmin-dump",
      sourceName: "Garmin Dump",
    });

    expect(processFitFileImportJob).toHaveBeenCalled();
  });

  it("FIT file import batch processor delegates to processFitFileImportBatchJob", async () => {
    const { processFitFileImportBatchJob } = await import("./process-fit-file-import-batch-job.ts");
    vi.mocked(processFitFileImportBatchJob).mockClear();

    await invokeProcessor("fit-file-import-batch-queue", { type: "fit-file-import-batch" });

    expect(processFitFileImportBatchJob).toHaveBeenCalled();
  });

  it("ZIP entry extract processor delegates to processZipEntryExtractJob", async () => {
    const { processZipEntryExtractJob } = await import("./process-zip-entry-extract-job.ts");
    vi.mocked(processZipEntryExtractJob).mockClear();

    await invokeProcessor("zip-entry-extract-queue", {
      archivePath: "/tmp/archive.zip",
      entryPath: ["activity.fit"],
      outputExtension: "fit",
    });

    expect(processZipEntryExtractJob).toHaveBeenCalled();
  });

  it("scheduled-sync processor delegates to processScheduledSyncJob", async () => {
    const { processScheduledSyncJob } = await import("./process-scheduled-sync-job.ts");
    vi.mocked(processScheduledSyncJob).mockClear();

    await invokeProcessor("scheduled-sync-queue", { type: "scheduled-sync-all" });

    expect(processScheduledSyncJob).toHaveBeenCalled();
  });

  it("post-sync processor delegates to processPostSyncJob", async () => {
    const { processPostSyncJob } = await import("./process-post-sync-job.ts");
    vi.mocked(processPostSyncJob).mockClear();

    await invokeProcessor("post-sync-queue", { type: "user-refit", userId: "u" });

    expect(processPostSyncJob).toHaveBeenCalled();
  });

  it("activity-delete-analytics processor delegates to processActivityDeleteAnalyticsJob", async () => {
    const { processActivityDeleteAnalyticsJob } = await import(
      "./process-activity-delete-analytics-job.ts"
    );
    vi.mocked(processActivityDeleteAnalyticsJob).mockClear();

    await invokeProcessor("activity-delete-analytics-queue", {
      type: "activity-delete-analytics-refresh",
      userId: "user-1",
      activityIds: ["00000000-0000-0000-0000-000000000001"],
    });

    expect(processActivityDeleteAnalyticsJob).toHaveBeenCalled();
  });

  it("provider-data-deletion processor delegates to processProviderDataDeletionJob", async () => {
    const { markProviderDataDeletionCompleted } = await import("../db/provider-data-deletion.ts");
    const { processProviderDataDeletionJob } = await import(
      "./process-provider-data-deletion-job.ts"
    );
    const { enqueueProviderDeleteAnalyticsRefresh } = await import("./queues.ts");
    vi.mocked(markProviderDataDeletionCompleted).mockClear();
    vi.mocked(processProviderDataDeletionJob).mockClear();

    await invokeProcessor("provider-data-deletion-queue", {
      type: "provider-data-deletion",
      eventId: "30000000-0000-4000-8000-000000000003",
      generation: 2,
      providerId: "garmin",
      userId: "00000000-0000-4000-8000-000000000004",
    });

    expect(processProviderDataDeletionJob).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        clickHouseClient: mockClickHouseClient,
        enqueueAnalyticsRefresh: enqueueProviderDeleteAnalyticsRefresh,
        markCompleted: expect.any(Function),
      }),
    );
    const dependencies = vi.mocked(processProviderDataDeletionJob).mock.calls[0]?.[1];
    if (!dependencies) throw new Error("provider deletion dependencies were not passed");
    await dependencies.markCompleted("30000000-0000-4000-8000-000000000003");
    expect(markProviderDataDeletionCompleted).toHaveBeenCalledWith(
      mockDatabase,
      "30000000-0000-4000-8000-000000000003",
    );
  });

  it("account-erasure processor validates and delegates to the durable phase runner", async () => {
    const requestId = "50000000-0000-4000-8000-000000001994";
    hoisted.mockProcessAccountErasureRequest.mockClear();

    await invokeProcessor("account-erasure-queue", {
      type: "account-erasure",
      requestId,
    });

    expect(hoisted.mockProcessAccountErasureRequest).toHaveBeenCalledWith(
      mockDatabase,
      requestId,
      expect.stringMatching(/^account-erasure-worker:/),
      hoisted.mockAccountErasurePhaseRunner,
    );
  });

  it("rejects invalid account-erasure payloads without disclosing their contents", async () => {
    const privateEmail = "private@example.com";
    hoisted.mockProcessAccountErasureRequest.mockClear();

    await expect(
      invokeProcessor("account-erasure-queue", {
        type: "account-erasure",
        requestId: 1994,
        privateEmail,
      }),
    ).rejects.toThrow("Invalid account erasure job payload");
    await expect(
      invokeProcessor("account-erasure-queue", {
        type: "account-erasure",
        requestId: 1994,
        privateEmail,
      }),
    ).rejects.not.toThrow(privateEmail);
    expect(hoisted.mockProcessAccountErasureRequest).not.toHaveBeenCalled();
  });
});
