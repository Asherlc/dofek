import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCaptureException = vi.fn();
vi.mock("@sentry/node", () => ({ captureException: mockCaptureException }));

const mockLoggerWarn = vi.fn();
vi.mock("../logger.ts", () => ({ logger: { warn: mockLoggerWarn } }));

const mockImportQueue = {
  getJob: vi.fn(),
  getJobs: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
};
const mockBatchQueue = {
  getJob: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
};
vi.mock("./queues.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./queues.ts")>();
  return {
    ...actual,
    FIT_FILE_IMPORT_BATCH_QUEUE: "fit-file-import-batch",
    IMPORT_QUEUE: "import",
    createImportQueue: vi.fn(() => mockImportQueue),
    createFitFileImportBatchQueue: vi.fn(() => mockBatchQueue),
  };
});

const { createGarminImportProgressCoordinator } = await import("./garmin-import-progress.ts");

function deferred<Value>() {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  if (!resolvePromise) {
    throw new Error("Deferred promise resolver was not initialized");
  }
  return { promise, resolve: resolvePromise };
}

function waitingCheckpoint(totalFitFiles = 10) {
  return {
    version: 1 as const,
    phase: "waiting-children" as const,
    startedAtMs: 1_784_073_600_000,
    batchId: "batch-1",
    baseResult: { recordsSynced: 2, errors: [] },
    tempDirectories: ["/tmp/extract-1"],
    totalFitFiles,
  };
}

interface TestProgressImportJob {
  id: string;
  data: {
    filePath: string;
    since: string;
    userId: string;
    importType: string;
    checkpoint: unknown;
  };
  progress: unknown;
  updateProgress: CallableVitestMock;
}

function createImportJob(
  progress: unknown = { percentage: 0, message: "Preparing..." },
): TestProgressImportJob {
  return {
    id: "import-1",
    data: {
      filePath: "/tmp/upload.zip",
      since: "2026-07-01T00:00:00.000Z",
      userId: "user-1",
      importType: "garmin-dump",
      checkpoint: waitingCheckpoint(),
    },
    progress,
    updateProgress: vi.fn().mockResolvedValue(undefined),
  };
}

function createBatchJob() {
  return {
    id: "batch-1",
    parent: { id: "import-1", queueKey: "bull:import" },
    getDependenciesCount: vi.fn().mockResolvedValue({
      processed: 3,
      ignored: 1,
      failed: 0,
      unprocessed: 6,
    }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockImportQueue.close.mockResolvedValue(undefined);
  mockBatchQueue.close.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createGarminImportProgressCoordinator", () => {
  it("debounces FIT terminal events and updates the waiting import from dependency counts", async () => {
    const importJob = createImportJob();
    const batchJob = createBatchJob();
    mockImportQueue.getJob.mockResolvedValue(importJob);
    mockBatchQueue.getJob.mockResolvedValue(batchJob);
    const coordinator = createGarminImportProgressCoordinator();
    const fitJob = {
      parent: { id: "batch-1", queueKey: "bull:fit-file-import-batch" },
    };

    coordinator.observeFitJob(fitJob);
    coordinator.observeFitJob(fitJob);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(mockBatchQueue.getJob).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(mockBatchQueue.getJob).toHaveBeenCalledOnce();
    expect(batchJob.getDependenciesCount).toHaveBeenCalledWith({
      failed: true,
      ignored: true,
      processed: true,
      unprocessed: true,
    });
    expect(importJob.updateProgress).toHaveBeenCalledWith({
      percentage: 36,
      message: "Importing Garmin FIT activities (4 succeeded, 0 failed, 4 of 10 processed)...",
    });
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it("reports cumulative progress across every FIT import batch", async () => {
    const importJob = createImportJob();
    importJob.data.checkpoint = {
      ...waitingCheckpoint(1_000),
      batchIds: ["batch-1", "batch-2"],
    };
    const firstBatchJob = createBatchJob();
    firstBatchJob.getDependenciesCount.mockResolvedValue({
      processed: 490,
      ignored: 0,
      failed: 10,
      unprocessed: 0,
    });
    const secondBatchJob = {
      ...createBatchJob(),
      id: "batch-2",
    };
    secondBatchJob.getDependenciesCount.mockResolvedValue({
      processed: 140,
      ignored: 0,
      failed: 10,
      unprocessed: 350,
    });
    mockImportQueue.getJob.mockResolvedValue(importJob);
    mockBatchQueue.getJob.mockImplementation(async (batchId: string) =>
      batchId === "batch-1" ? firstBatchJob : secondBatchJob,
    );
    const coordinator = createGarminImportProgressCoordinator();

    coordinator.observeFitJob({
      parent: { id: "batch-2", queueKey: "bull:fit-file-import-batch" },
    });
    await vi.runAllTimersAsync();

    expect(importJob.updateProgress).toHaveBeenCalledWith({
      percentage: 58.5,
      message:
        "Importing Garmin FIT activities (630 succeeded, 20 failed, 650 of 1000 processed)...",
      failedCount: 20,
    });
  });

  it("reports missing checkpoint batch jobs instead of silently skipping progress", async () => {
    const importJob = createImportJob();
    importJob.data.checkpoint = {
      ...waitingCheckpoint(),
      batchIds: ["batch-1", "missing-batch"],
    };
    const batchJob = createBatchJob();
    mockImportQueue.getJob.mockResolvedValue(importJob);
    mockBatchQueue.getJob.mockImplementation(async (batchId: string) =>
      batchId === "batch-1" ? batchJob : undefined,
    );
    const coordinator = createGarminImportProgressCoordinator();

    coordinator.observeFitJob({
      parent: { id: "batch-1", queueKey: "bull:fit-file-import-batch" },
    });
    await vi.runAllTimersAsync();

    expect(mockCaptureException).toHaveBeenCalledOnce();
    const [reportedError, context] = mockCaptureException.mock.calls[0] ?? [];
    expect(reportedError).toEqual(
      new Error("Garmin import import-1 is missing FIT batch jobs: missing-batch"),
    );
    expect(context).toEqual({
      tags: { garminDumpStep: "progress-refresh" },
      extra: { batchId: "batch-1" },
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Failed to refresh Garmin import progress for batch %s: %s",
      "batch-1",
      reportedError,
    );
    expect(importJob.updateProgress).not.toHaveBeenCalled();
  });

  it("ignores events that are not children of a FIT import batch", () => {
    const coordinator = createGarminImportProgressCoordinator();

    coordinator.observeFitJob({});
    coordinator.observeFitJob({ parent: { queueKey: "bull:fit-file-import-batch" } });
    coordinator.observeFitJob({ parent: { id: "batch-1", queueKey: "bull:other-batch" } });

    expect(vi.getTimerCount()).toBe(0);
    expect(mockBatchQueue.getJob).not.toHaveBeenCalled();
  });

  it("never replaces newer import progress with an older dependency snapshot", async () => {
    const importJob = createImportJob({ percentage: 75, message: "Newer progress" });
    mockImportQueue.getJob.mockResolvedValue(importJob);
    mockBatchQueue.getJob.mockResolvedValue(createBatchJob());
    const coordinator = createGarminImportProgressCoordinator();

    coordinator.observeFitJob({
      parent: { id: "batch-1", queueKey: "bull:fit-file-import-batch" },
    });
    await vi.runAllTimersAsync();

    expect(importJob.updateProgress).not.toHaveBeenCalled();
  });

  it("preserves fractional FIT progress for the UI", async () => {
    const importJob = createImportJob({
      percentage: (353 / 15_774) * 90,
      message:
        "Importing Garmin FIT activities (353 succeeded, 0 failed, 353 of 15774 processed)...",
    });
    importJob.data.checkpoint = waitingCheckpoint(15_774);
    const batchJob = createBatchJob();
    batchJob.getDependenciesCount.mockResolvedValue({
      processed: 354,
      ignored: 0,
      failed: 0,
      unprocessed: 15_420,
    });
    mockImportQueue.getJob.mockResolvedValue(importJob);
    mockBatchQueue.getJob.mockResolvedValue(batchJob);
    const coordinator = createGarminImportProgressCoordinator();

    coordinator.observeFitJob({
      parent: { id: "batch-1", queueKey: "bull:fit-file-import-batch" },
    });
    await vi.runAllTimersAsync();

    expect(importJob.updateProgress).toHaveBeenCalledWith({
      percentage: (354 / 15_774) * 90,
      message:
        "Importing Garmin FIT activities (354 succeeded, 0 failed, 354 of 15774 processed)...",
    });
  });

  it("does not rewrite progress when the dependency snapshot matches it exactly", async () => {
    const importJob = createImportJob({
      percentage: 36,
      message: "Importing Garmin FIT activities (4 succeeded, 0 failed, 4 of 10 processed)...",
    });
    mockImportQueue.getJob.mockResolvedValue(importJob);
    mockBatchQueue.getJob.mockResolvedValue(createBatchJob());
    const coordinator = createGarminImportProgressCoordinator();

    coordinator.observeFitJob({
      parent: { id: "batch-1", queueKey: "bull:fit-file-import-batch" },
    });
    await vi.runAllTimersAsync();

    expect(importJob.updateProgress).not.toHaveBeenCalled();
  });

  it("updates the processed counts when the percentage is unchanged", async () => {
    const importJob = createImportJob({
      percentage: 36,
      message: "Importing Garmin FIT activities (3 succeeded, 1 failed, 4 of 10 processed)...",
    });
    mockImportQueue.getJob.mockResolvedValue(importJob);
    mockBatchQueue.getJob.mockResolvedValue(createBatchJob());
    const coordinator = createGarminImportProgressCoordinator();

    coordinator.observeFitJob({
      parent: { id: "batch-1", queueKey: "bull:fit-file-import-batch" },
    });
    await vi.runAllTimersAsync();

    expect(importJob.updateProgress).toHaveBeenCalledWith({
      percentage: 36,
      message: "Importing Garmin FIT activities (4 succeeded, 0 failed, 4 of 10 processed)...",
    });
  });

  it("updates the percentage when the processed-count message is unchanged", async () => {
    const message = "Importing Garmin FIT activities (4 succeeded, 0 failed, 4 of 10 processed)...";
    const importJob = createImportJob({ percentage: 0, message });
    mockImportQueue.getJob.mockResolvedValue(importJob);
    mockBatchQueue.getJob.mockResolvedValue(createBatchJob());
    const coordinator = createGarminImportProgressCoordinator();

    coordinator.observeFitJob({
      parent: { id: "batch-1", queueKey: "bull:fit-file-import-batch" },
    });
    await vi.runAllTimersAsync();

    expect(importJob.updateProgress).toHaveBeenCalledWith({ percentage: 36, message });
  });

  it("treats an empty FIT batch as fully imported", async () => {
    const importJob = createImportJob();
    importJob.data.checkpoint = waitingCheckpoint(0);
    const batchJob = createBatchJob();
    batchJob.getDependenciesCount.mockResolvedValue({
      processed: 0,
      ignored: 0,
      failed: 0,
      unprocessed: 0,
    });
    mockImportQueue.getJob.mockResolvedValue(importJob);
    mockBatchQueue.getJob.mockResolvedValue(batchJob);
    const coordinator = createGarminImportProgressCoordinator();

    coordinator.observeFitJob({
      parent: { id: "batch-1", queueKey: "bull:fit-file-import-batch" },
    });
    await vi.runAllTimersAsync();

    expect(importJob.updateProgress).toHaveBeenCalledWith({
      percentage: 90,
      message: "Importing Garmin FIT activities (0 succeeded, 0 failed, 0 of 0 processed)...",
    });
  });

  it("caps dependency counts above the total at 90 percent", async () => {
    const importJob = createImportJob();
    const batchJob = createBatchJob();
    batchJob.getDependenciesCount.mockResolvedValue({
      processed: 7,
      ignored: 2,
      failed: 3,
      unprocessed: 0,
    });
    mockImportQueue.getJob.mockResolvedValue(importJob);
    mockBatchQueue.getJob.mockResolvedValue(batchJob);
    const coordinator = createGarminImportProgressCoordinator();

    coordinator.observeFitJob({
      parent: { id: "batch-1", queueKey: "bull:fit-file-import-batch" },
    });
    await vi.runAllTimersAsync();

    expect(importJob.updateProgress).toHaveBeenCalledWith({
      percentage: 90,
      message: "Importing Garmin FIT activities (7 succeeded, 3 failed, 10 of 10 processed)...",
      failedCount: 3,
    });
  });

  it("shows failed count separately when most FIT files fail", async () => {
    const importJob = createImportJob();
    importJob.data.checkpoint = waitingCheckpoint(15774);
    const batchJob = createBatchJob();
    batchJob.getDependenciesCount.mockResolvedValue({
      processed: 356,
      ignored: 0,
      failed: 15418,
      unprocessed: 0,
    });
    mockImportQueue.getJob.mockResolvedValue(importJob);
    mockBatchQueue.getJob.mockResolvedValue(batchJob);
    const coordinator = createGarminImportProgressCoordinator();

    coordinator.observeFitJob({
      parent: { id: "batch-1", queueKey: "bull:fit-file-import-batch" },
    });
    await vi.runAllTimersAsync();

    expect(importJob.updateProgress).toHaveBeenCalledWith({
      percentage: 90,
      message:
        "Importing Garmin FIT activities (356 succeeded, 15418 failed, 15774 of 15774 processed)...",
      failedCount: 15418,
    });
  });

  it("serializes overlapping refreshes so an older snapshot cannot regress progress", async () => {
    const firstCounts = deferred<{
      processed: number;
      ignored: number;
      failed: number;
      unprocessed: number;
    }>();
    const firstImportSnapshot = createImportJob();
    const secondImportSnapshot = createImportJob();
    const progressUpdates: number[] = [];
    firstImportSnapshot.updateProgress.mockImplementation(
      async ({ percentage }: { percentage: number }) => {
        progressUpdates.push(percentage);
      },
    );
    secondImportSnapshot.updateProgress.mockImplementation(
      async ({ percentage }: { percentage: number }) => {
        progressUpdates.push(percentage);
      },
    );
    const batchJob = createBatchJob();
    batchJob.getDependenciesCount
      .mockImplementationOnce(() => firstCounts.promise)
      .mockResolvedValueOnce({ processed: 8, ignored: 0, failed: 0, unprocessed: 2 });
    mockImportQueue.getJob
      .mockResolvedValueOnce(firstImportSnapshot)
      .mockResolvedValueOnce(secondImportSnapshot);
    mockBatchQueue.getJob.mockResolvedValue(batchJob);
    const coordinator = createGarminImportProgressCoordinator();
    const fitJob = {
      parent: { id: "batch-1", queueKey: "bull:fit-file-import-batch" },
    };

    coordinator.observeFitJob(fitJob);
    await vi.advanceTimersByTimeAsync(2_000);
    coordinator.observeFitJob(fitJob);
    await vi.advanceTimersByTimeAsync(2_000);
    firstCounts.resolve({ processed: 4, ignored: 0, failed: 0, unprocessed: 6 });
    await vi.runAllTimersAsync();

    expect(progressUpdates).toEqual([36, 72]);
  });

  it("schedules a new refresh after the previous refresh finished", async () => {
    const importJob = createImportJob();
    mockImportQueue.getJob.mockResolvedValue(importJob);
    mockBatchQueue.getJob.mockResolvedValue(createBatchJob());
    const coordinator = createGarminImportProgressCoordinator();
    const fitJob = {
      parent: { id: "batch-1", queueKey: "bull:fit-file-import-batch" },
    };

    coordinator.observeFitJob(fitJob);
    await vi.runAllTimersAsync();
    coordinator.observeFitJob(fitJob);
    expect(vi.getTimerCount()).toBe(1);
    await vi.runAllTimersAsync();

    expect(mockBatchQueue.getJob).toHaveBeenCalledTimes(2);
  });

  it("loads pending batch jobs concurrently", async () => {
    const firstBatchLookup = deferred<ReturnType<typeof createBatchJob> | null>();
    let firstBatchLookupSettled = false;
    let secondBatchLookupStartedBeforeFirstSettled = false;
    mockBatchQueue.getJob.mockImplementation((batchId: string) => {
      if (batchId === "batch-1") {
        return firstBatchLookup.promise;
      }
      secondBatchLookupStartedBeforeFirstSettled = !firstBatchLookupSettled;
      return Promise.resolve(null);
    });
    const coordinator = createGarminImportProgressCoordinator();

    coordinator.observeFitJob({
      parent: { id: "batch-1", queueKey: "bull:fit-file-import-batch" },
    });
    coordinator.observeFitJob({
      parent: { id: "batch-2", queueKey: "bull:fit-file-import-batch" },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(mockBatchQueue.getJob).toHaveBeenCalledWith("batch-1"));
    firstBatchLookupSettled = true;
    firstBatchLookup.resolve(null);
    await vi.runAllTimersAsync();

    expect(secondBatchLookupStartedBeforeFirstSettled).toBe(true);
  });

  it("reconciles waiting Garmin imports after a worker restart", async () => {
    const importJob = createImportJob();
    const batchJob = createBatchJob();
    mockImportQueue.getJobs.mockResolvedValue([importJob]);
    mockImportQueue.getJob.mockResolvedValue(importJob);
    mockBatchQueue.getJob.mockResolvedValue(batchJob);
    const coordinator = createGarminImportProgressCoordinator();

    await coordinator.reconcile();

    expect(mockImportQueue.getJobs).toHaveBeenCalledWith(["waiting-children"], 0, -1, false);
    expect(importJob.updateProgress).toHaveBeenCalledWith({
      percentage: 36,
      message: "Importing Garmin FIT activities (4 succeeded, 0 failed, 4 of 10 processed)...",
    });
  });

  it("reconciles only valid waiting Garmin checkpoints", async () => {
    const importJob = createImportJob();
    const wrongProviderJob = createImportJob();
    wrongProviderJob.data.importType = "whoop";
    wrongProviderJob.data.checkpoint = {
      ...waitingCheckpoint(),
      batchId: "wrong-provider-batch",
    };
    const invalidCheckpointJob = createImportJob();
    invalidCheckpointJob.data.checkpoint = { version: 1, phase: "waiting-children" };
    const preparedJob = createImportJob();
    preparedJob.data.checkpoint = {
      ...waitingCheckpoint(),
      phase: "prepared",
      batchId: "prepared-batch",
    };
    mockImportQueue.getJobs.mockResolvedValue([
      wrongProviderJob,
      invalidCheckpointJob,
      preparedJob,
      importJob,
    ]);
    mockImportQueue.getJob.mockResolvedValue(importJob);
    mockBatchQueue.getJob.mockResolvedValue(createBatchJob());
    const coordinator = createGarminImportProgressCoordinator();

    await coordinator.reconcile();

    expect(mockBatchQueue.getJob).toHaveBeenCalledOnce();
    expect(mockBatchQueue.getJob).toHaveBeenCalledWith("batch-1");
    expect(importJob.updateProgress).toHaveBeenCalledOnce();
  });

  it("finishes a reconciliation requested while an event refresh is in flight", async () => {
    const firstCounts = deferred<{
      processed: number;
      ignored: number;
      failed: number;
      unprocessed: number;
    }>();
    const importJob = createImportJob();
    const batchJob = createBatchJob();
    batchJob.getDependenciesCount
      .mockImplementationOnce(() => firstCounts.promise)
      .mockResolvedValueOnce({ processed: 5, ignored: 0, failed: 0, unprocessed: 5 });
    mockImportQueue.getJobs.mockResolvedValue([importJob]);
    mockImportQueue.getJob.mockResolvedValue(importJob);
    mockBatchQueue.getJob.mockResolvedValue(batchJob);
    const coordinator = createGarminImportProgressCoordinator();

    coordinator.observeFitJob({
      parent: { id: "batch-1", queueKey: "bull:fit-file-import-batch" },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const reconciliation = coordinator.reconcile();
    await vi.waitFor(() => expect(mockImportQueue.getJobs).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(mockBatchQueue.getJob).toHaveBeenCalledOnce();
    firstCounts.resolve({ processed: 4, ignored: 0, failed: 0, unprocessed: 6 });
    await reconciliation;

    expect(mockBatchQueue.getJob).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["missing batch", () => ({ batchJob: null, importJob: createImportJob() })],
    [
      "batch without a parent",
      () => ({
        batchJob: { ...createBatchJob(), parent: undefined },
        importJob: createImportJob(),
      }),
    ],
    ["missing import", () => ({ batchJob: createBatchJob(), importJob: null })],
    [
      "non-Garmin import",
      () => {
        const importJob = createImportJob();
        importJob.data.importType = "whoop";
        return { batchJob: createBatchJob(), importJob };
      },
    ],
    [
      "invalid checkpoint",
      () => {
        const importJob = createImportJob();
        importJob.data.checkpoint = { version: 1, phase: "waiting-children" };
        return { batchJob: createBatchJob(), importJob };
      },
    ],
    [
      "prepared checkpoint",
      () => {
        const importJob = createImportJob();
        importJob.data.checkpoint = { ...waitingCheckpoint(), phase: "prepared" };
        return { batchJob: createBatchJob(), importJob };
      },
    ],
  ])("skips progress refresh for a %s", async (_, createScenario) => {
    const { batchJob, importJob } = createScenario();
    mockBatchQueue.getJob.mockResolvedValue(batchJob);
    mockImportQueue.getJob.mockResolvedValue(importJob);
    const coordinator = createGarminImportProgressCoordinator();

    coordinator.observeFitJob({
      parent: { id: "batch-1", queueKey: "bull:fit-file-import-batch" },
    });
    await vi.runAllTimersAsync();

    if (batchJob) {
      expect(batchJob.getDependenciesCount).not.toHaveBeenCalled();
    }
    if (importJob) {
      expect(importJob.updateProgress).not.toHaveBeenCalled();
    }
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it("reports progress refresh failures without creating an unhandled rejection", async () => {
    const refreshError = new Error("Redis unavailable");
    mockBatchQueue.getJob.mockRejectedValue(refreshError);
    const coordinator = createGarminImportProgressCoordinator();

    coordinator.observeFitJob({
      parent: { id: "batch-1", queueKey: "bull:fit-file-import-batch" },
    });
    await vi.runAllTimersAsync();

    expect(mockCaptureException).toHaveBeenCalledWith(refreshError, {
      tags: { garminDumpStep: "progress-refresh" },
      extra: { batchId: "batch-1" },
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Failed to refresh Garmin import progress for batch %s: %s",
      "batch-1",
      refreshError,
    );
  });

  it("closes both queue resources", async () => {
    const coordinator = createGarminImportProgressCoordinator();

    await coordinator.close();

    expect(mockImportQueue.close).toHaveBeenCalledOnce();
    expect(mockBatchQueue.close).toHaveBeenCalledOnce();
  });

  it("cancels a pending refresh when closed", async () => {
    const coordinator = createGarminImportProgressCoordinator();
    coordinator.observeFitJob({
      parent: { id: "batch-1", queueKey: "bull:fit-file-import-batch" },
    });

    await coordinator.close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(mockBatchQueue.getJob).not.toHaveBeenCalled();
  });

  it("ignores FIT terminal events after closing", async () => {
    const coordinator = createGarminImportProgressCoordinator();

    await coordinator.close();
    coordinator.observeFitJob({
      parent: { id: "batch-1", queueKey: "bull:fit-file-import-batch" },
    });
    await vi.runAllTimersAsync();

    expect(mockBatchQueue.getJob).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});
