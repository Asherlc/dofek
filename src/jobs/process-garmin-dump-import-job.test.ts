import { WaitingChildrenError } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database, SyncDatabase } from "../db/index.ts";
import {
  cleanupPreparedGarminDumpImport,
  prepareGarminDumpImport,
} from "../providers/garmin-dump.ts";
import { attachGarminFitImportFlow } from "./garmin-dump-flow.ts";
import type { LocalImportJobData as ImportJobData } from "./local-import-job-data.ts";
import { processGarminDumpImportJob } from "./process-garmin-dump-import-job.ts";

const { mockCaptureException, mockLoggerWarn } = vi.hoisted(() => ({
  mockCaptureException: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));
const mockWithUserWriteFence = vi.fn(
  async (
    database: unknown,
    _userId: string,
    operation: (transaction: unknown) => Promise<unknown>,
  ) => operation(database),
);

vi.mock("@sentry/node", () => ({ captureException: mockCaptureException }));
vi.mock("../db/account-erasure.ts", () => ({
  withAccountErasureUserWriteFence: (
    database: unknown,
    userId: string,
    operation: (transaction: unknown) => Promise<unknown>,
  ) => mockWithUserWriteFence(database, userId, operation),
}));

vi.mock("../logger.ts", () => ({ logger: { warn: mockLoggerWarn } }));

vi.mock("../providers/garmin-dump.ts", () => ({
  cleanupPreparedGarminDumpImport: vi.fn(),
  prepareGarminDumpImport: vi.fn(),
}));

vi.mock("./garmin-dump-flow.ts", () => ({
  attachGarminFitImportFlow: vi.fn(),
  createBatchId: vi.fn((preparedImport: { batchId: string }, batchIndex: number) =>
    batchIndex === 0 ? preparedImport.batchId : `${preparedImport.batchId}-batch-${batchIndex}`,
  ),
  FLOW_BATCH_SIZE: 500,
}));

const mockDb: SyncDatabase & Pick<Database, "transaction"> = {
  select: vi.fn(),
  insert: vi.fn(),
  delete: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
};

interface TestImportJob {
  id: string;
  queueQualifiedName: string;
  data: ImportJobData;
  updateData: ReturnType<typeof vi.fn>;
  moveToWaitingChildren: ReturnType<typeof vi.fn>;
  getChildrenValues: ReturnType<typeof vi.fn>;
  getIgnoredChildrenFailures: ReturnType<typeof vi.fn>;
  extendLock: ReturnType<typeof vi.fn>;
  updateProgress: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
}

function createJob(checkpoint?: unknown): TestImportJob {
  const job: TestImportJob = {
    id: "import-1",
    queueQualifiedName: "bull:import",
    data: {
      filePath: "/job-files/upload.zip",
      since: "2026-07-01T00:00:00.000Z",
      userId: "user-1",
      importType: "garmin-dump",
      checkpoint,
    },
    updateData: vi.fn(),
    moveToWaitingChildren: vi.fn().mockResolvedValue(true),
    getChildrenValues: vi.fn().mockResolvedValue({}),
    getIgnoredChildrenFailures: vi.fn().mockResolvedValue({}),
    extendLock: vi.fn().mockResolvedValue(undefined),
    updateProgress: vi.fn().mockResolvedValue(undefined),
    log: vi.fn().mockResolvedValue(undefined),
  };
  job.updateData.mockImplementation(async (data: ImportJobData) => {
    job.data = data;
  });
  return job;
}

const preparedImport = {
  uploadPath: "/job-files/upload.zip",
  userId: "user-1",
  batchId: "garmin-fit-batch-1",
  baseResult: {
    recordsSynced: 2,
    errors: [{ message: "one summary was invalid" }],
  },
  fitJobEntries: [
    {
      entry: { path: "activity.fit", filePath: "/job-files/extracted/activity.fit" },
      data: {
        originalPath: "activity.fit",
        userId: "user-1",
        providerId: "garmin-dump",
        sourceName: "Garmin",
      },
    },
  ],
  tempDirectories: ["/job-files/upload.zip-extract-a"],
  totalFitFiles: 1,
};

function waitingCheckpoint() {
  return {
    version: 1 as const,
    phase: "waiting-children" as const,
    startedAtMs: 1_784_073_600_000,
    batchId: preparedImport.batchId,
    baseResult: preparedImport.baseResult,
    tempDirectories: preparedImport.tempDirectories,
    totalFitFiles: preparedImport.totalFitFiles,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prepareGarminDumpImport).mockResolvedValue(preparedImport);
  vi.mocked(attachGarminFitImportFlow).mockResolvedValue(undefined);
  vi.mocked(cleanupPreparedGarminDumpImport).mockResolvedValue(undefined);
  mockWithUserWriteFence.mockImplementation(
    async (
      database: unknown,
      _userId: string,
      operation: (transaction: unknown) => Promise<unknown>,
    ) => operation(database),
  );
});

describe("processGarminDumpImportJob", () => {
  it("persists preparation before attaching the deterministic flow and yielding", async () => {
    const job = createJob();
    const events: string[] = [];
    job.updateData.mockImplementation(async (data: ImportJobData) => {
      const checkpoint = data.checkpoint;
      if (typeof checkpoint === "object" && checkpoint && "phase" in checkpoint) {
        events.push(`persist-${String(checkpoint.phase)}`);
      }
      job.data = data;
    });
    vi.mocked(attachGarminFitImportFlow).mockImplementation(async () => {
      events.push("attach-flow");
    });
    job.moveToWaitingChildren.mockImplementation(async () => {
      events.push("yield-parent");
      return true;
    });

    await expect(processGarminDumpImportJob(job, mockDb)).rejects.toBeInstanceOf(
      WaitingChildrenError,
    );

    expect(events).toEqual([
      "persist-prepared",
      "attach-flow",
      "persist-waiting-children",
      "yield-parent",
    ]);
    expect(attachGarminFitImportFlow).toHaveBeenCalledWith(preparedImport, {
      id: "import-1",
      queue: "bull:import",
    });
    expect(mockWithUserWriteFence).toHaveBeenCalledWith(mockDb, "user-1", expect.any(Function));
    expect(prepareGarminDumpImport).toHaveBeenCalledWith(
      mockDb,
      "/job-files/upload.zip",
      "user-1",
      expect.objectContaining({ preserveTempDirectories: [] }),
    );
    expect(cleanupPreparedGarminDumpImport).not.toHaveBeenCalled();
    expect(job.log.mock.calls).toEqual([
      ["[phase] Prepared Garmin dump batch garmin-fit-batch-1 with 1 FIT file"],
      ["[phase] Attached Garmin FIT flow for batch garmin-fit-batch-1"],
      ["[phase] Waiting for 1 Garmin FIT file in batch garmin-fit-batch-1"],
    ]);
  });

  it("continues orchestration when phase log persistence fails", async () => {
    const logError = new Error("Redis job log unavailable");
    const job = createJob();
    job.log.mockRejectedValue(logError);

    await expect(processGarminDumpImportJob(job, mockDb)).rejects.toBeInstanceOf(
      WaitingChildrenError,
    );

    expect(attachGarminFitImportFlow).toHaveBeenCalledOnce();
    expect(job.moveToWaitingChildren).toHaveBeenCalledOnce();
    expect(mockCaptureException).toHaveBeenCalledWith(logError, {
      tags: { garminDumpStep: "job-log" },
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Failed to append Garmin import job log: %s",
      logError,
    );
  });

  it("uses plural FIT labels when preparing and waiting for multiple files", async () => {
    const job = createJob();
    vi.mocked(prepareGarminDumpImport).mockResolvedValue({
      ...preparedImport,
      fitJobEntries: [...preparedImport.fitJobEntries, ...preparedImport.fitJobEntries],
      totalFitFiles: 2,
    });

    await expect(processGarminDumpImportJob(job, mockDb)).rejects.toBeInstanceOf(
      WaitingChildrenError,
    );

    expect(job.log).toHaveBeenCalledWith(
      "[phase] Prepared Garmin dump batch garmin-fit-batch-1 with 2 FIT files",
    );
    expect(job.log).toHaveBeenCalledWith(
      "[phase] Waiting for 2 Garmin FIT files in batch garmin-fit-batch-1",
    );
  });

  it("forwards preparation progress to the durable import job", async () => {
    const job = createJob();
    vi.mocked(prepareGarminDumpImport).mockImplementation(
      async (_db, _filePath, _userId, options) => {
        if (!options?.onProgress) {
          throw new Error("Expected Garmin import preparation progress callback");
        }
        await options.onProgress({ percentage: 20, message: "Extracting Garmin archive..." });
        return preparedImport;
      },
    );

    await expect(processGarminDumpImportJob(job, mockDb)).rejects.toBeInstanceOf(
      WaitingChildrenError,
    );

    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 20,
      message: "Extracting Garmin archive...",
    });
  });

  it("persists the initial orchestration start time", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_784_073_612_345);
    const job = createJob();

    await expect(processGarminDumpImportJob(job, mockDb)).rejects.toBeInstanceOf(
      WaitingChildrenError,
    );

    expect(job.data.checkpoint).toEqual(
      expect.objectContaining({ startedAtMs: 1_784_073_612_345 }),
    );
    nowSpy.mockRestore();
  });

  it("returns to waiting children without repeating preparation after attachment", async () => {
    const job = createJob(waitingCheckpoint());

    await expect(processGarminDumpImportJob(job, mockDb)).rejects.toBeInstanceOf(
      WaitingChildrenError,
    );

    expect(prepareGarminDumpImport).not.toHaveBeenCalled();
    expect(attachGarminFitImportFlow).not.toHaveBeenCalled();
    expect(job.updateData).not.toHaveBeenCalled();
    expect(cleanupPreparedGarminDumpImport).not.toHaveBeenCalled();
  });

  it("rebuilds a prepared flow without duplicates while retaining every cleanup directory", async () => {
    const oldDirectory = "/job-files/upload.zip-extract-old";
    const job = createJob({
      ...waitingCheckpoint(),
      phase: "prepared",
      tempDirectories: [oldDirectory],
    });

    await expect(processGarminDumpImportJob(job, mockDb)).rejects.toBeInstanceOf(
      WaitingChildrenError,
    );

    expect(prepareGarminDumpImport).toHaveBeenCalledOnce();
    expect(prepareGarminDumpImport).toHaveBeenCalledWith(
      mockDb,
      "/job-files/upload.zip",
      "user-1",
      expect.objectContaining({ preserveTempDirectories: [oldDirectory] }),
    );
    expect(job.data.checkpoint).toEqual(
      expect.objectContaining({
        phase: "waiting-children",
        startedAtMs: 1_784_073_600_000,
        tempDirectories: [oldDirectory, ...preparedImport.tempDirectories],
      }),
    );
    expect(attachGarminFitImportFlow).toHaveBeenCalledOnce();
  });

  it("finalizes immediately when every child finished before the parent could yield", async () => {
    const job = createJob();
    job.moveToWaitingChildren.mockResolvedValue(false);
    job.getChildrenValues.mockResolvedValue({
      "bull:fit-file-import-batch:garmin-fit-batch-1": {
        recordsSynced: 3,
        errors: [{ message: "one FIT file failed" }],
      },
    });

    const result = await processGarminDumpImportJob(job, mockDb);

    expect(result).toEqual({
      provider: "garmin-dump",
      batchId: "garmin-fit-batch-1",
      totalFitFiles: 1,
      recordsSynced: 5,
      errors: [{ message: "one summary was invalid" }, { message: "one FIT file failed" }],
      duration: expect.any(Number),
    });
    expect(cleanupPreparedGarminDumpImport).toHaveBeenCalledWith(preparedImport.tempDirectories);
    expect(job.log).toHaveBeenLastCalledWith(
      "[phase] Finalized Garmin dump batch garmin-fit-batch-1: 5 activities, 2 error groups",
    );
  });

  it("finalizes a reactivated parent from its persisted checkpoint and child value", async () => {
    const job = createJob(waitingCheckpoint());
    job.moveToWaitingChildren.mockResolvedValue(false);
    job.getChildrenValues.mockResolvedValue({
      "bull:fit-file-import-batch:garmin-fit-batch-1": {
        recordsSynced: 3,
        errors: [],
      },
    });

    const result = await processGarminDumpImportJob(job, mockDb);

    expect(result.recordsSynced).toBe(5);
    expect(result.batchId).toBe("garmin-fit-batch-1");
    expect(result.totalFitFiles).toBe(1);
    expect(prepareGarminDumpImport).not.toHaveBeenCalled();
    expect(cleanupPreparedGarminDumpImport).toHaveBeenCalledWith(preparedImport.tempDirectories);
  });

  it("turns an ignored batch failure into a bounded terminal result", async () => {
    const job = createJob(waitingCheckpoint());
    job.moveToWaitingChildren.mockResolvedValue(false);
    job.getIgnoredChildrenFailures.mockResolvedValue({
      "bull:fit-file-import-batch:garmin-fit-batch-1": "batch Redis connection failed",
    });

    const result = await processGarminDumpImportJob(job, mockDb);

    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toEqual([
      { message: "one summary was invalid" },
      { message: "Garmin FIT batch failed: batch Redis connection failed" },
    ]);
  });

  it("finalizes zero FIT files without throwing", async () => {
    const job = createJob({
      ...waitingCheckpoint(),
      totalFitFiles: 0,
      batchIds: [],
    });
    job.moveToWaitingChildren.mockResolvedValue(false);

    const result = await processGarminDumpImportJob(job, mockDb);

    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toEqual([{ message: "one summary was invalid" }]);
    expect(result.totalFitFiles).toBe(0);
  });

  it("merges partial batch failures into successful batch results", async () => {
    const job = createJob({
      ...waitingCheckpoint(),
      batchIds: ["garmin-fit-batch-1", "garmin-fit-batch-1-batch-1"],
    });
    job.moveToWaitingChildren.mockResolvedValue(false);
    job.getChildrenValues.mockResolvedValue({
      "bull:fit-file-import-batch:garmin-fit-batch-1": {
        recordsSynced: 3,
        errors: [],
      },
    });
    job.getIgnoredChildrenFailures.mockResolvedValue({
      "bull:fit-file-import-batch:garmin-fit-batch-1-batch-1": "batch Redis connection failed",
    });

    const result = await processGarminDumpImportJob(job, mockDb);

    expect(result.recordsSynced).toBe(5);
    expect(result.errors).toEqual([
      { message: "one summary was invalid" },
      { message: "Garmin FIT batch failed: batch Redis connection failed" },
    ]);
  });

  it("bounds combined preparation and FIT error groups", async () => {
    const baseErrors = Array.from({ length: 7 }, (_, errorIndex) => ({
      message: `summary error ${errorIndex + 1}`,
    }));
    const fitErrors = Array.from({ length: 6 }, (_, errorIndex) => ({
      message: `FIT error group ${errorIndex + 1}`,
    }));
    const job = createJob({
      ...waitingCheckpoint(),
      baseResult: { recordsSynced: 2, errors: baseErrors },
    });
    job.moveToWaitingChildren.mockResolvedValue(false);
    job.getChildrenValues.mockResolvedValue({
      "bull:fit-file-import-batch:garmin-fit-batch-1": {
        recordsSynced: 3,
        errors: fitErrors,
      },
    });

    const result = await processGarminDumpImportJob(job, mockDb);

    expect(result.errors).toHaveLength(10);
    expect(result.errors.slice(0, fitErrors.length)).toEqual(fitErrors);
    expect(result.errors.at(-1)).toEqual({
      message: "4 additional Garmin import error groups omitted",
    });
  });

  it("keeps exactly ten combined error groups without an omission summary", async () => {
    const baseErrors = Array.from({ length: 4 }, (_, errorIndex) => ({
      message: `summary error ${errorIndex + 1}`,
    }));
    const fitErrors = Array.from({ length: 6 }, (_, errorIndex) => ({
      message: `FIT error group ${errorIndex + 1}`,
    }));
    const job = createJob({
      ...waitingCheckpoint(),
      baseResult: { recordsSynced: 2, errors: baseErrors },
    });
    job.moveToWaitingChildren.mockResolvedValue(false);
    job.getChildrenValues.mockResolvedValue({
      "bull:fit-file-import-batch:garmin-fit-batch-1": {
        recordsSynced: 3,
        errors: fitErrors,
      },
    });

    const result = await processGarminDumpImportJob(job, mockDb);

    expect(result.errors).toEqual([...baseErrors, ...fitErrors]);
  });

  it("fails when neither the batch result nor its ignored failure was persisted", async () => {
    const job = createJob(waitingCheckpoint());
    job.moveToWaitingChildren.mockResolvedValue(false);

    await expect(processGarminDumpImportJob(job, mockDb)).rejects.toThrow(
      "Garmin FIT batch result is missing: garmin-fit-batch-1",
    );

    expect(cleanupPreparedGarminDumpImport).not.toHaveBeenCalled();
  });

  it("reports one Sentry event per unique error group at finalize", async () => {
    const job = createJob(waitingCheckpoint());
    job.moveToWaitingChildren.mockResolvedValue(false);
    job.getChildrenValues.mockResolvedValue({
      "bull:fit-file-import-batch:garmin-fit-batch-1": {
        recordsSynced: 3,
        errors: [
          { message: "15000 FIT files failed: expected string, received number" },
          { message: "200 FIT files failed: invalid session start time" },
        ],
      },
    });

    await processGarminDumpImportJob(job, mockDb);

    // 1 base error + 2 FIT error groups = 3 events
    expect(mockCaptureException).toHaveBeenCalledTimes(3);
    for (const call of mockCaptureException.mock.calls) {
      expect(call[0]).toBeInstanceOf(Error);
      expect(call[1]).toEqual({ tags: { garminDumpStep: "import-summary" } });
    }
  });

  it("does not capture Sentry at finalize when there are no errors", async () => {
    const job = createJob({
      ...waitingCheckpoint(),
      baseResult: { recordsSynced: 2, errors: [] },
    });
    job.moveToWaitingChildren.mockResolvedValue(false);
    job.getChildrenValues.mockResolvedValue({
      "bull:fit-file-import-batch:garmin-fit-batch-1": {
        recordsSynced: 3,
        errors: [],
      },
    });

    await processGarminDumpImportJob(job, mockDb);

    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("computes duration from the saved orchestration start", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_784_073_600_500);
    const job = createJob(waitingCheckpoint());
    job.moveToWaitingChildren.mockResolvedValue(false);
    job.getChildrenValues.mockResolvedValue({
      "bull:fit-file-import-batch:garmin-fit-batch-1": {
        recordsSynced: 3,
        errors: [],
      },
    });

    const result = await processGarminDumpImportJob(job, mockDb);

    expect(result.duration).toBe(500);
    nowSpy.mockRestore();
  });

  it("fails loudly when persisted checkpoint data is invalid", async () => {
    const job = createJob({ version: 1, phase: "waiting-children" });

    await expect(processGarminDumpImportJob(job, mockDb)).rejects.toThrow();

    expect(prepareGarminDumpImport).not.toHaveBeenCalled();
    expect(job.moveToWaitingChildren).not.toHaveBeenCalled();
  });
});
