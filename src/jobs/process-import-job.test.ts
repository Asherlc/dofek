import { tmpdir } from "node:os";
import { join } from "node:path";
import { WaitingChildrenError } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../db/index.ts";
import { createMetricStreamEvent, type MetricStreamRowInput } from "../metric-stream/events.ts";
import type { MetricStreamPublishOptions } from "../metric-stream/redpanda-producer.ts";
import type { KayaImportDatabase } from "../providers/kaya/import.ts";
import { APPLE_HEALTH_IMPORT_VALIDATION_ERROR_NAME } from "./import-validation-error.ts";
import type { LocalImportJobData as ImportJobData } from "./local-import-job-data.ts";

const mockCaptureException = vi.fn();
vi.mock("@sentry/node", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));
const mockWithUserWriteFence = vi.fn(
  async (
    database: unknown,
    _userId: string,
    operation: (transaction: unknown) => Promise<unknown>,
  ) => operation(database),
);
vi.mock("../db/account-erasure.ts", () => ({
  withAccountErasureUserWriteFence: (
    database: unknown,
    userId: string,
    operation: (transaction: unknown) => Promise<unknown>,
  ) => mockWithUserWriteFence(database, userId, operation),
}));
const mockIsAccountErasureActive = vi.fn(async (..._args: unknown[]) => false);
vi.mock("../db/account-erasure-processing.ts", () => ({
  isAccountErasureActive: (...args: unknown[]) => mockIsAccountErasureActive(...args),
}));
let realUnlink: typeof import("node:fs/promises").unlink;
const mockUnlink = vi.fn<(path: string) => Promise<void>>();
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  realUnlink = actual.unlink;
  return { ...actual, unlink: (...args: [string]) => mockUnlink(...args) };
});
const { writeFile, access } = await import("node:fs/promises");

const mockLoggerInfo = vi.fn();
const mockLoggerError = vi.fn();
const mockLoggerWarn = vi.fn();
const mockInvalidateAllUserQueries = vi.fn().mockResolvedValue(undefined);

vi.mock("../lib/cache.ts", () => ({
  invalidateAllUserQueries: (...args: unknown[]) => mockInvalidateAllUserQueries(...args),
}));

vi.mock("../logger.ts", () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    debug: vi.fn(),
  },
}));
const processingOperationId = "30000000-0000-4000-8000-000000000002";
const mockCreateProcessingOperation = vi.fn(
  async (
    _database: unknown,
    input: {
      userId: string | null;
      providerId?: string | null;
      kind: "file_import";
      externalCorrelationKey?: string | null;
      datasetKeys: string[];
    },
  ) => ({
    id: processingOperationId,
    userId: input.userId,
    providerId: input.providerId ?? null,
    kind: input.kind,
    externalCorrelationKey: input.externalCorrelationKey ?? null,
    datasetKeys: input.datasetKeys,
    createdAt: new Date("2026-06-02T12:00:00.000Z"),
  }),
);
const mockAppendProcessingStageEvent = vi.fn(
  async (_database: unknown, _input: unknown) => undefined,
);
const mockRecordMetricStreamBatchPublished = vi.fn(
  async (_database: unknown, _input: unknown) => undefined,
);
const mockRecordRelationalCanonicalCommits = vi.fn(
  async (_database: unknown, _input: unknown) => undefined,
);
vi.mock("../processing/processing-event-store.ts", () => ({
  appendProcessingStageEvent: (database: unknown, input: unknown) =>
    mockAppendProcessingStageEvent(database, input),
  createProcessingOperation: (
    database: unknown,
    input: Parameters<typeof mockCreateProcessingOperation>[1],
  ) => mockCreateProcessingOperation(database, input),
  recordMetricStreamBatchPublished: (database: unknown, input: unknown) =>
    mockRecordMetricStreamBatchPublished(database, input),
  recordRelationalCanonicalCommits: (database: unknown, input: unknown) =>
    mockRecordRelationalCanonicalCommits(database, input),
}));
const mockMetricStreamPublishRows = vi.fn(
  async (rows: readonly MetricStreamRowInput[], options: MetricStreamPublishOptions) =>
    rows.map((row) => createMetricStreamEvent(row, options.operationRevision)),
);
vi.mock("../metric-stream/redpanda-producer.ts", () => ({
  getDefaultMetricStreamEventPublisher: vi.fn(async () => ({
    publishRows: mockMetricStreamPublishRows,
  })),
}));
// Mock dependencies with module-level mock functions (avoids `as` casts)
const mockLogSync = vi.fn().mockResolvedValue(undefined);
vi.mock("../db/sync-log.ts", () => ({
  logSync: (...args: unknown[]) => mockLogSync(...args),
}));
const mockEnsureProvider = vi.fn().mockResolvedValue(undefined);
vi.mock("../db/tokens.ts", () => ({
  ensureProvider: (...args: unknown[]) => mockEnsureProvider(...args),
}));
const mockEnqueueDebouncedPostSyncMaintenance = vi.fn().mockResolvedValue(undefined);
const mockEnqueueDebouncedUserRefit = vi.fn().mockResolvedValue(undefined);
vi.mock("./queues.ts", () => ({
  enqueueDebouncedPostSyncMaintenance: (...args: unknown[]) =>
    mockEnqueueDebouncedPostSyncMaintenance(...args),
  enqueueDebouncedUserRefit: (...args: unknown[]) => mockEnqueueDebouncedUserRefit(...args),
}));

const mockImportAppleHealthFile = vi.fn().mockResolvedValue({
  recordsSynced: 42,
  errors: [],
});
class MockAppleHealthImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppleHealthImportValidationError";
  }
}
vi.mock("../providers/apple-health/import.ts", () => ({
  importAppleHealthFile: (...args: unknown[]) => mockImportAppleHealthFile(...args),
  AppleHealthImportValidationError: MockAppleHealthImportValidationError,
}));
const mockImportStrongCsv = vi.fn().mockResolvedValue({
  recordsSynced: 10,
  errors: [],
});
vi.mock("../providers/strong-csv.ts", () => ({
  importStrongCsv: (...args: unknown[]) => mockImportStrongCsv(...args),
}));
const mockImportCronometerCsv = vi.fn().mockResolvedValue({
  recordsSynced: 7,
  errors: [],
});
vi.mock("../providers/cronometer-csv.ts", () => ({
  importCronometerCsv: (...args: unknown[]) => mockImportCronometerCsv(...args),
}));
const mockImportKayaExportFile = vi.fn().mockResolvedValue({
  recordsSynced: 4,
  errors: [],
});
vi.mock("../providers/kaya/import.ts", () => ({
  importKayaExportFile: (...args: unknown[]) => mockImportKayaExportFile(...args),
}));
const mockImportZosAppBin = vi.fn().mockResolvedValue({
  recordsSynced: 3,
  errors: [],
});
vi.mock("../providers/zos-app/provider.ts", () => ({
  importZosAppBin: (...args: unknown[]) => mockImportZosAppBin(...args),
}));

const mockProcessGarminDumpImportJob = vi.fn().mockResolvedValue({
  provider: "garmin-dump",
  batchId: "garmin-fit-batch-1",
  totalFitFiles: 5,
  recordsSynced: 5,
  errors: [],
  duration: 100,
});
vi.mock("./process-garmin-dump-import-job.ts", () => ({
  processGarminDumpImportJob: (...args: unknown[]) => mockProcessGarminDumpImportJob(...args),
}));
const mockImportFitFile = vi.fn().mockResolvedValue({
  recordsSynced: 1,
  errors: [],
});
vi.mock("./process-fit-file-import-job.ts", () => ({
  importFitFile: (...args: unknown[]) => mockImportFitFile(...args),
}));
// Import after mocks
const { processImportJob } = await import("./process-import-job.ts");
// All DB functions are mocked at module level, so the db object is never actually called.
const mockDb: KayaImportDatabase = {
  select: vi.fn(),
  insert: vi.fn(),
  delete: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
};
interface MockJob {
  id: string;
  queueQualifiedName: string;
  data: ImportJobData;
  updateProgress: ReturnType<typeof vi.fn>;
  updateData: ReturnType<typeof vi.fn>;
  moveToWaitingChildren: ReturnType<typeof vi.fn>;
  getChildrenValues: ReturnType<typeof vi.fn>;
  getIgnoredChildrenFailures: ReturnType<typeof vi.fn>;
  extendLock: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
}

function createMockJob(overrides: Partial<ImportJobData> = {}): MockJob {
  const job: MockJob = {
    id: "import-job-1",
    queueQualifiedName: "bull:import-test",
    data: {
      filePath: "/tmp/test-upload.zip",
      since: "2024-01-01T00:00:00.000Z",
      userId: "user-1",
      importType: "apple-health",
      ...overrides,
    },
    updateProgress: vi.fn().mockResolvedValue(undefined),
    updateData: vi.fn().mockResolvedValue(undefined),
    moveToWaitingChildren: vi.fn().mockResolvedValue(false),
    getChildrenValues: vi.fn().mockResolvedValue({}),
    getIgnoredChildrenFailures: vi.fn().mockResolvedValue({}),
    extendLock: vi.fn().mockResolvedValue(undefined),
    log: vi.fn().mockResolvedValue(undefined),
  };
  job.updateData.mockImplementation(async (data: ImportJobData) => {
    job.data = data;
  });
  return job;
}
// Helper to call processImportJob with a mock job.
// processImportJob accepts any object with .data and .updateProgress (ImportJob interface).
function runImportJob(job: MockJob, db: SyncDatabase) {
  return processImportJob(job, db);
}
describe("processImportJob", () => {
  let tempFilePath: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    // By default, call through to the real unlink so existing cleanup tests work
    mockUnlink.mockImplementation((path: string) => realUnlink(path));

    // Create a real temp file so unlink doesn't fail
    tempFilePath = join(tmpdir(), `test-import-${Date.now()}.tmp`);
    await writeFile(tempFilePath, "test data");
    // Restore default return values after clearAllMocks
    mockLogSync.mockResolvedValue(undefined);
    mockEnsureProvider.mockResolvedValue(undefined);
    mockCaptureException.mockReset();
    mockImportAppleHealthFile.mockResolvedValue({ recordsSynced: 42, errors: [] });
    mockImportStrongCsv.mockResolvedValue({ recordsSynced: 10, errors: [] });
    mockImportCronometerCsv.mockResolvedValue({ recordsSynced: 7, errors: [] });
    mockImportKayaExportFile.mockResolvedValue({ recordsSynced: 4, errors: [] });
    mockImportZosAppBin.mockResolvedValue({ recordsSynced: 3, errors: [] });
    mockProcessGarminDumpImportJob.mockResolvedValue({
      provider: "garmin-dump",
      batchId: "garmin-fit-batch-1",
      totalFitFiles: 5,
      recordsSynced: 5,
      errors: [],
      duration: 100,
    });
    mockImportFitFile.mockResolvedValue({ recordsSynced: 1, errors: [] });
    mockEnqueueDebouncedPostSyncMaintenance.mockResolvedValue(undefined);
    mockEnqueueDebouncedUserRefit.mockResolvedValue(undefined);
    mockInvalidateAllUserQueries.mockResolvedValue(undefined);
    mockCreateProcessingOperation.mockClear();
    mockAppendProcessingStageEvent.mockClear();
    mockRecordMetricStreamBatchPublished.mockClear();
    mockRecordRelationalCanonicalCommits.mockClear();
    mockMetricStreamPublishRows.mockClear();
    mockWithUserWriteFence.mockImplementation(
      async (
        database: unknown,
        _userId: string,
        operation: (transaction: unknown) => Promise<unknown>,
      ) => operation(database),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  describe("apple-health import", () => {
    it("records the import lifecycle and correlates emitted metric batches", async () => {
      mockImportAppleHealthFile.mockImplementationOnce(
        async (
          _database: unknown,
          _filePath: unknown,
          _since: unknown,
          _onProgress: unknown,
          metricStreamPublisher: {
            publishRows(
              rows: readonly MetricStreamRowInput[],
              options: MetricStreamPublishOptions,
            ): Promise<unknown>;
          },
        ) => {
          await metricStreamPublisher.publishRows(
            [
              {
                recordedAt: "2026-06-02T10:00:00.000Z",
                userId: "00000000-0000-4000-8000-000000000001",
                providerId: "apple_health",
                externalId: "heart-rate-1",
                sourceType: "file",
                channel: "heart_rate",
                scalar: 72,
              },
            ],
            { operationRevision: "1000000000000000" },
          );
          return { recordsSynced: 1, errors: [] };
        },
      );
      const job = createMockJob({
        filePath: tempFilePath,
        importType: "apple-health",
        userId: "00000000-0000-4000-8000-000000000001",
      });

      await runImportJob(job, mockDb);

      expect(mockInvalidateAllUserQueries).toHaveBeenCalledWith(
        "00000000-0000-4000-8000-000000000001",
      );
      expect(mockCreateProcessingOperation).toHaveBeenCalledWith(mockDb, {
        userId: "00000000-0000-4000-8000-000000000001",
        providerId: "apple_health",
        kind: "file_import",
        externalCorrelationKey: "import-job-1",
        datasetKeys: [
          "activity",
          "hiking",
          "cycling",
          "sleep",
          "recovery",
          "training",
          "body",
          "nutrition",
          "providers",
        ],
      });
      expect(mockAppendProcessingStageEvent).toHaveBeenNthCalledWith(1, mockDb, {
        operationId: processingOperationId,
        stage: "ingest",
        status: "queued",
        progressPercentage: 0,
        idempotencyKey: "worker-queued",
      });
      expect(mockAppendProcessingStageEvent).toHaveBeenNthCalledWith(2, mockDb, {
        operationId: processingOperationId,
        stage: "ingest",
        status: "running",
        progressPercentage: 0,
        idempotencyKey: "worker-running",
      });
      expect(mockMetricStreamPublishRows).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          processing: expect.objectContaining({ operationId: processingOperationId }),
        }),
      );
      expect(mockRecordMetricStreamBatchPublished).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({ operationId: processingOperationId, expectedEventCount: 1 }),
      );
      expect(mockRecordRelationalCanonicalCommits).toHaveBeenCalledWith(mockDb, {
        operationId: processingOperationId,
        datasetKeys: [
          "activity",
          "hiking",
          "cycling",
          "sleep",
          "recovery",
          "training",
          "nutrition",
          "providers",
        ],
        idempotencyKey: "worker-relational-commit:import-job-1",
      });
      expect(mockAppendProcessingStageEvent).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          operationId: processingOperationId,
          stage: "ingest",
          status: "succeeded",
          idempotencyKey: "worker-succeeded",
        }),
      );
    });

    it("calls importAppleHealthFile with correct args and reports progress", async () => {
      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await runImportJob(job, mockDb);
      expect(mockImportAppleHealthFile).toHaveBeenCalledWith(
        mockDb,
        tempFilePath,
        new Date("2024-01-01T00:00:00.000Z"),
        expect.any(Function),
        expect.any(Object),
      );
    });

    it("omits empty record, workout, and sleep counts from progress", async () => {
      mockImportAppleHealthFile.mockImplementationOnce(
        async (
          _database: unknown,
          _filePath: unknown,
          _since: unknown,
          onProgress: (info: {
            percentage: number;
            recordCount: number;
            workoutCount: number;
            sleepCount: number;
          }) => void,
        ) => {
          onProgress({ percentage: 10, recordCount: 0, workoutCount: 0, sleepCount: 0 });
          return { recordsSynced: 0, errors: [] };
        },
      );
      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });

      await runImportJob(job, mockDb);

      expect(job.updateProgress).toHaveBeenCalledWith({
        percentage: 9,
        message: "Importing health data...",
      });
    });

    it("fails metric publication when the database has no transaction support", async () => {
      mockImportAppleHealthFile.mockImplementationOnce(
        async (
          _database: unknown,
          _filePath: unknown,
          _since: unknown,
          _onProgress: unknown,
          metricStreamPublisher: {
            publishRows(
              rows: readonly MetricStreamRowInput[],
              options: MetricStreamPublishOptions,
            ): Promise<unknown>;
          },
        ) => {
          await metricStreamPublisher.publishRows(
            [
              {
                recordedAt: "2026-06-02T10:00:00.000Z",
                userId: "00000000-0000-4000-8000-000000000001",
                providerId: "apple_health",
                externalId: "heart-rate-1",
                sourceType: "file",
                channel: "heart_rate",
                scalar: 72,
              },
            ],
            { operationRevision: "1000000000000000" },
          );
          return { recordsSynced: 0, errors: [] };
        },
      );
      const nonTransactionalDatabase: SyncDatabase = {
        select: vi.fn(),
        insert: vi.fn(),
        delete: vi.fn(),
        execute: vi.fn(),
      };
      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });

      await expect(runImportJob(job, nonTransactionalDatabase)).rejects.toThrow(
        "Processing metric-stream publication requires a transactional database",
      );
    });

    it("does not fabricate relational or no-output events for a metric-only result", async () => {
      mockImportAppleHealthFile.mockImplementationOnce(
        async (
          _database: unknown,
          _filePath: unknown,
          _since: unknown,
          _onProgress: unknown,
          metricStreamPublisher: {
            publishRows(
              rows: readonly MetricStreamRowInput[],
              options: MetricStreamPublishOptions,
            ): Promise<unknown>;
          },
        ) => {
          await metricStreamPublisher.publishRows(
            [
              {
                recordedAt: "2026-06-02T10:00:00.000Z",
                userId: "00000000-0000-4000-8000-000000000001",
                providerId: "apple_health",
                externalId: "heart-rate-1",
                sourceType: "file",
                channel: "heart_rate",
                scalar: 72,
              },
            ],
            { operationRevision: "1000000000000000" },
          );
          return { recordsSynced: 0, errors: [] };
        },
      );
      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });

      await runImportJob(job, mockDb);

      expect(mockRecordMetricStreamBatchPublished).toHaveBeenCalledOnce();
      expect(mockRecordRelationalCanonicalCommits).not.toHaveBeenCalled();
      expect(mockAppendProcessingStageEvent).not.toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({ status: "skipped" }),
      );
    });

    it("logs sync on success", async () => {
      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await runImportJob(job, mockDb);
      expect(mockLogSync).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          providerId: "apple_health",
          dataType: "import",
          status: "success",
          recordCount: 42,
        }),
      );
    });
    it("logs sync as error when import has errors", async () => {
      mockImportAppleHealthFile.mockResolvedValue({
        recordsSynced: 10,
        errors: [{ message: "bad record 1" }, { message: "bad record 2" }],
      });
      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await runImportJob(job, mockDb);
      expect(mockLogSync).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          providerId: "apple_health",
          status: "error",
          errorMessage: "bad record 1; bad record 2",
        }),
      );
    });

    it("scales streaming progress to 0-90% range with descriptive messages", async () => {
      mockImportAppleHealthFile.mockImplementation(
        async (
          _db: unknown,
          _path: unknown,
          _since: unknown,
          onProgress: (info: {
            percentage: number;
            recordCount: number;
            workoutCount: number;
            sleepCount: number;
          }) => void,
        ) => {
          onProgress({ percentage: 50, recordCount: 1000, workoutCount: 5, sleepCount: 0 });
          onProgress({ percentage: 100, recordCount: 2000, workoutCount: 10, sleepCount: 3 });
          return { recordsSynced: 10, errors: [] };
        },
      );
      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await runImportJob(job, mockDb);
      // 50% streaming → 45% reported (50 * 0.9), message includes counts
      expect(job.updateProgress).toHaveBeenCalledWith({
        percentage: 45,
        message: "Importing health data (1,000 records, 5 workouts)...",
      });
      // 100% streaming → 90% reported (100 * 0.9)
      expect(job.updateProgress).toHaveBeenCalledWith({
        percentage: 90,
        message: "Importing health data (2,000 records, 10 workouts, 3 sleep sessions)...",
      });
    });
    it("logs warning when updateProgress rejects", async () => {
      const progressError = new Error("Redis connection lost");
      mockImportAppleHealthFile.mockImplementation(
        async (
          _db: unknown,
          _path: unknown,
          _since: unknown,
          onProgress: (info: {
            percentage: number;
            recordCount: number;
            workoutCount: number;
            sleepCount: number;
          }) => void,
        ) => {
          onProgress({ percentage: 50, recordCount: 100, workoutCount: 1, sleepCount: 0 });
          return { recordsSynced: 10, errors: [] };
        },
      );

      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      job.updateProgress.mockRejectedValue(progressError);
      await runImportJob(job, mockDb);
      const importProgressWarnings = mockLoggerWarn.mock.calls.filter(
        ([message]) => message === "Failed to update import progress: %s",
      );
      expect(importProgressWarnings).toEqual([
        ["Failed to update import progress: %s", progressError],
        ["Failed to update import progress: %s", progressError],
      ]);
      expect(mockCaptureException).toHaveBeenNthCalledWith(1, progressError, {
        tags: { phase: "import-progress-update" },
      });
      expect(mockCaptureException).toHaveBeenNthCalledWith(2, progressError, {
        tags: { phase: "import-progress-update" },
      });
      expect(mockCaptureException).toHaveBeenCalledTimes(2);
    });
    it("only logs progress at 10% increments", async () => {
      mockImportAppleHealthFile.mockImplementation(
        async (
          _db: unknown,
          _path: unknown,
          _since: unknown,
          onProgress: (info: { percentage: number }) => void,
        ) => {
          onProgress({ percentage: 5 });
          onProgress({ percentage: 9 });
          onProgress({ percentage: 10 });
          onProgress({ percentage: 15 });
          onProgress({ percentage: 20 });
          return { recordsSynced: 10, errors: [] };
        },
      );
      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await runImportJob(job, mockDb);
      // Should log at 10% and 20%, but not at 5%, 9%, or 15%
      const progressLogs = mockLoggerInfo.mock.calls.filter((call) =>
        String(call[0]).includes("progress"),
      );
      expect(progressLogs).toHaveLength(2);
      expect(String(progressLogs.at(0))).toContain("10%");
      expect(String(progressLogs.at(1))).toContain("20%");
    });

    it("logs completion message with record count", async () => {
      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await runImportJob(job, mockDb);
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.stringContaining("Apple Health import complete"),
      );
      expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining("42 records imported"));
    });
  });
  describe("strong-csv import", () => {
    it("reads file and calls importStrongCsv with correct args", async () => {
      await writeFile(tempFilePath, "Date,Exercise,Reps\n2024-01-01,Squat,10");
      const job = createMockJob({
        filePath: tempFilePath,
        importType: "strong-csv",
        weightUnit: "lbs",
      });
      await runImportJob(job, mockDb);
      expect(mockImportStrongCsv).toHaveBeenCalledWith(
        mockDb,
        "Date,Exercise,Reps\n2024-01-01,Squat,10",
        "user-1",
        "lbs",
      );
    });

    it("defaults to kg when weightUnit is not specified", async () => {
      await writeFile(tempFilePath, "csv data");
      const job = createMockJob({
        filePath: tempFilePath,
        importType: "strong-csv",
        weightUnit: undefined,
      });
      await runImportJob(job, mockDb);
      expect(mockImportStrongCsv).toHaveBeenCalledWith(mockDb, "csv data", "user-1", "kg");
    });
    it("logs sync and completion message on success", async () => {
      await writeFile(tempFilePath, "csv data");
      const job = createMockJob({ filePath: tempFilePath, importType: "strong-csv" });
      await runImportJob(job, mockDb);

      expect(mockLogSync).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          providerId: "strong-csv",
          dataType: "import",
          status: "success",
          recordCount: 10,
        }),
      );
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.stringContaining("Strong CSV import complete"),
      );
      expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining("10 workouts imported"));
    });
    it("reports progress", async () => {
      await writeFile(tempFilePath, "csv data");
      const job = createMockJob({ filePath: tempFilePath, importType: "strong-csv" });
      await runImportJob(job, mockDb);
      expect(job.updateProgress).toHaveBeenCalledWith({
        percentage: 0,
        message: "Starting Strong CSV import...",
      });
      expect(job.updateProgress).toHaveBeenCalledWith({
        percentage: 10,
        message: "Reading Strong CSV file...",
      });
      expect(job.updateProgress).toHaveBeenCalledWith({
        percentage: 25,
        message: "Importing Strong CSV workouts...",
      });
      expect(job.updateProgress).toHaveBeenCalledWith({
        percentage: 90,
        message: "Strong CSV import complete.",
      });
    });
  });
  describe("cronometer-csv import", () => {
    it("reads file and calls importCronometerCsv with correct args", async () => {
      await writeFile(tempFilePath, "Day,Food Name,Amount\n2024-01-01,Rice,100g");

      const job = createMockJob({ filePath: tempFilePath, importType: "cronometer-csv" });
      await runImportJob(job, mockDb);
      expect(mockImportCronometerCsv).toHaveBeenCalledWith(
        mockDb,
        "Day,Food Name,Amount\n2024-01-01,Rice,100g",
        "user-1",
      );
    });
    it("logs sync and completion message on success", async () => {
      await writeFile(tempFilePath, "csv data");
      const job = createMockJob({ filePath: tempFilePath, importType: "cronometer-csv" });
      await runImportJob(job, mockDb);
      expect(mockLogSync).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          providerId: "cronometer-csv",
          dataType: "import",
          status: "success",
          recordCount: 7,
        }),
      );
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.stringContaining("Cronometer CSV import complete"),
      );
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.stringContaining("7 food entries imported"),
      );
    });

    it("reports progress", async () => {
      await writeFile(tempFilePath, "csv data");
      const job = createMockJob({ filePath: tempFilePath, importType: "cronometer-csv" });
      await runImportJob(job, mockDb);
      expect(job.updateProgress).toHaveBeenCalledWith({
        percentage: 0,
        message: "Starting Cronometer CSV import...",
      });
      expect(job.updateProgress).toHaveBeenCalledWith({
        percentage: 10,
        message: "Reading Cronometer CSV file...",
      });
      expect(job.updateProgress).toHaveBeenCalledWith({
        percentage: 25,
        message: "Importing Cronometer food entries...",
      });
      expect(job.updateProgress).toHaveBeenCalledWith({
        percentage: 90,
        message: "Cronometer CSV import complete.",
      });
    });
  });
  describe("kaya-export import", () => {
    it("reads file and calls importKayaExportFile with correct args", async () => {
      await writeFile(
        tempFilePath,
        "date,stiffness,rating,ascent_type,attempts,grade,color,climb_name,gym,location,country\nThu Jul 09 2026 15:17:17 GMT+0000 (GMT+00:00),0,,Onsight,1,v3,Pink,,Touchstone Pacific Pipe,,",
      );
      const job = createMockJob({ filePath: tempFilePath, importType: "kaya-export" });
      await runImportJob(job, mockDb);

      expect(mockImportKayaExportFile).toHaveBeenCalledWith(
        mockDb,
        expect.stringContaining("Touchstone Pacific Pipe"),
        "user-1",
      );
      expect(mockCreateProcessingOperation).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({ providerId: "kaya" }),
      );
    });
    it("logs sync and completion message on success", async () => {
      await writeFile(tempFilePath, "csv data");
      const job = createMockJob({ filePath: tempFilePath, importType: "kaya-export" });
      await runImportJob(job, mockDb);
      expect(mockLogSync).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          providerId: "kaya-export",
          dataType: "import",
          status: "success",
          recordCount: 4,
        }),
      );
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.stringContaining("Kaya export import complete"),
      );
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.stringContaining("4 climbing entries imported"),
      );
    });
    it("fails loudly when Kaya import runs without transactional database support", async () => {
      await writeFile(tempFilePath, "csv data");
      const nonTransactionalDb: SyncDatabase = {
        select: vi.fn(),
        insert: vi.fn(),
        delete: vi.fn(),
        execute: vi.fn(),
      };
      const job = createMockJob({ filePath: tempFilePath, importType: "kaya-export" });

      await expect(runImportJob(job, nonTransactionalDb)).rejects.toThrow(
        "Kaya export import requires a transactional database",
      );
      expect(mockImportKayaExportFile).not.toHaveBeenCalled();
    });
    it("logs Kaya errors and duration precisely", async () => {
      await writeFile(tempFilePath, "csv data");
      mockImportKayaExportFile.mockResolvedValueOnce({
        recordsSynced: 0,
        errors: [{ message: "row 2: grade is unsupported" }],
      });
      let callCount = 0;
      const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
        return callCount++ === 0 ? 10_000 : 12_500;
      });
      const job = createMockJob({ filePath: tempFilePath, importType: "kaya-export" });
      await runImportJob(job, mockDb);
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.stringContaining("0 climbing entries imported, 1 errors in 2.5s"),
      );
      expect(mockLogSync).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          providerId: "kaya-export",
          status: "error",
          recordCount: 0,
          errorMessage: "row 2: grade is unsupported",
          durationMs: 2500,
        }),
      );
      dateNowSpy.mockRestore();
    });

    it("reports progress", async () => {
      await writeFile(tempFilePath, "csv data");
      const job = createMockJob({ filePath: tempFilePath, importType: "kaya-export" });
      await runImportJob(job, mockDb);
      expect(job.updateProgress).toHaveBeenCalledWith({
        percentage: 0,
        message: "Starting Kaya export import...",
      });
      expect(job.updateProgress).toHaveBeenCalledWith({
        percentage: 10,
        message: "Reading Kaya export file...",
      });
      expect(job.updateProgress).toHaveBeenCalledWith({
        percentage: 25,
        message: "Importing Kaya climbing entries...",
      });
      expect(job.updateProgress).toHaveBeenCalledWith({
        percentage: 90,
        message: "Kaya export import complete.",
      });
    });
  });
  describe("zos-app import", () => {
    it("reads binary file and calls importZosAppBin with correct args", async () => {
      const binContent = Buffer.from([0x49, 0x55, 0x4d, 0x31]);
      await writeFile(tempFilePath, binContent);
      const job = createMockJob({ filePath: tempFilePath, importType: "zos-app" });
      await runImportJob(job, mockDb);

      expect(mockImportZosAppBin).toHaveBeenCalledWith(mockDb, binContent, "user-1");
    });
    it("logs sync and completion message on success", async () => {
      await writeFile(tempFilePath, Buffer.from([0x00]));
      const job = createMockJob({ filePath: tempFilePath, importType: "zos-app" });
      await runImportJob(job, mockDb);
      expect(mockLogSync).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          providerId: "zos-app",
          dataType: "import",
          status: "success",
          recordCount: 3,
        }),
      );
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.stringContaining("ZOS App import complete"),
      );
    });
    it("logs error status when import has errors but some records synced", async () => {
      mockImportZosAppBin.mockResolvedValue({
        recordsSynced: 2,
        errors: [{ message: "corrupt session 3" }],
      });
      await writeFile(tempFilePath, Buffer.from([0x00]));

      const job = createMockJob({ filePath: tempFilePath, importType: "zos-app" });
      await runImportJob(job, mockDb);
      expect(mockLogSync).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          status: "error",
          recordCount: 2,
          errorMessage: "corrupt session 3",
        }),
      );
    });
    it("throws when zero records synced and errors present", async () => {
      mockImportZosAppBin.mockResolvedValue({
        recordsSynced: 0,
        errors: [{ message: "invalid magic" }],
      });
      await writeFile(tempFilePath, Buffer.from([0x00]));
      const job = createMockJob({ filePath: tempFilePath, importType: "zos-app" });
      await expect(runImportJob(job, mockDb)).rejects.toThrow(
        "ZOS App import failed: invalid magic",
      );
      expect(mockLogSync).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          providerId: "zos-app",
          status: "error",
          recordCount: 0,
          errorMessage: "invalid magic",
        }),
      );
    });

    it("does not throw when zero records but no errors", async () => {
      mockImportZosAppBin.mockResolvedValue({
        recordsSynced: 0,
        errors: [],
      });
      await writeFile(tempFilePath, Buffer.from([0x00]));
      const job = createMockJob({ filePath: tempFilePath, importType: "zos-app" });
      await expect(runImportJob(job, mockDb)).resolves.toBeUndefined();
    });
    it("reports progress", async () => {
      await writeFile(tempFilePath, Buffer.from([0x00]));
      const job = createMockJob({ filePath: tempFilePath, importType: "zos-app" });
      await runImportJob(job, mockDb);

      expect(job.updateProgress).toHaveBeenCalledWith({
        percentage: 0,
        message: "Starting ZOS App import...",
      });
      expect(job.updateProgress).toHaveBeenCalledWith({
        percentage: 10,
        message: "Reading ZOS App file...",
      });
      expect(job.updateProgress).toHaveBeenCalledWith({
        percentage: 25,
        message: "Importing ZOS App sessions...",
      });
      expect(job.updateProgress).toHaveBeenCalledWith({
        percentage: 90,
        message: "ZOS App import complete.",
      });
    });
  });
  describe("garmin-dump import", () => {
    it("delegates durable orchestration and runs terminal import side effects", async () => {
      const job = createMockJob({ filePath: tempFilePath, importType: "garmin-dump" });
      await runImportJob(job, mockDb);
      expect(mockProcessGarminDumpImportJob).toHaveBeenCalledWith(job, mockDb);
      expect(mockLogSync).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          providerId: "garmin-dump",
          status: "success",
          recordCount: 5,
        }),
      );
      expect(mockUnlink).toHaveBeenCalledWith(tempFilePath);
      expect(mockEnqueueDebouncedPostSyncMaintenance).toHaveBeenCalledOnce();
      expect(mockEnqueueDebouncedUserRefit).toHaveBeenCalledWith("user-1");
      expect(mockWithUserWriteFence).toHaveBeenCalledWith(mockDb, "user-1", expect.any(Function));
    });
    it("retains the upload and skips terminal side effects while waiting for children", async () => {
      const job = createMockJob({ filePath: tempFilePath, importType: "garmin-dump" });
      mockProcessGarminDumpImportJob.mockRejectedValueOnce(new WaitingChildrenError());

      await expect(runImportJob(job, mockDb)).rejects.toBeInstanceOf(WaitingChildrenError);
      expect(mockUnlink).not.toHaveBeenCalled();
      expect(mockLogSync).not.toHaveBeenCalled();
      expect(mockEnqueueDebouncedPostSyncMaintenance).not.toHaveBeenCalled();
      expect(mockEnqueueDebouncedUserRefit).not.toHaveBeenCalled();
      await expect(access(tempFilePath)).resolves.toBeUndefined();
    });
    it("retains the upload when durable orchestration fails before a terminal result", async () => {
      const job = createMockJob({ filePath: tempFilePath, importType: "garmin-dump" });
      mockProcessGarminDumpImportJob.mockRejectedValueOnce(
        new Error("waiting-children checkpoint write failed"),
      );

      await expect(runImportJob(job, mockDb)).rejects.toThrow(
        "waiting-children checkpoint write failed",
      );
      expect(mockUnlink).not.toHaveBeenCalled();
      expect(mockLogSync).not.toHaveBeenCalled();
      expect(mockEnqueueDebouncedPostSyncMaintenance).not.toHaveBeenCalled();
      expect(mockEnqueueDebouncedUserRefit).not.toHaveBeenCalled();
      await expect(access(tempFilePath)).resolves.toBeUndefined();
    });
    it("records terminal side effects before failing an incomplete import without retrying", async () => {
      const job = createMockJob({ filePath: tempFilePath, importType: "garmin-dump" });
      mockProcessGarminDumpImportJob.mockResolvedValueOnce({
        provider: "garmin-dump",
        batchId: "garmin-fit-batch-1",
        totalFitFiles: 5,
        recordsSynced: 4,
        errors: [{ message: "invalid activity.fit" }],
        duration: 100,
      });
      await expect(runImportJob(job, mockDb)).rejects.toEqual(
        expect.objectContaining({
          name: "UnrecoverableError",
          message:
            "Garmin dump import batch garmin-fit-batch-1 completed with errors after importing 4 activities across 5 FIT files: invalid activity.fit",
        }),
      );
      expect(mockLogSync).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          providerId: "garmin-dump",
          status: "error",
          recordCount: 4,
          errorMessage: "invalid activity.fit",
        }),
      );
      expect(mockUnlink).toHaveBeenCalledWith(tempFilePath);
      expect(mockEnqueueDebouncedPostSyncMaintenance).toHaveBeenCalledOnce();
      expect(mockEnqueueDebouncedUserRefit).toHaveBeenCalledWith("user-1");
    });

    it("does not convert a terminal import failure into success when erasure starts afterward", async () => {
      const job = createMockJob({ filePath: tempFilePath, importType: "garmin-dump" });
      mockIsAccountErasureActive.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      mockProcessGarminDumpImportJob.mockResolvedValueOnce({
        provider: "garmin-dump",
        batchId: "garmin-fit-batch-1",
        totalFitFiles: 1,
        recordsSynced: 0,
        errors: [{ message: "invalid activity.fit" }],
        duration: 100,
      });

      await expect(runImportJob(job, mockDb)).rejects.toMatchObject({
        name: "UnrecoverableError",
      });
    });
  });

  describe("fit-file import", () => {
    it("delegates FIT decoding and records the import lifecycle", async () => {
      const job = createMockJob({ filePath: tempFilePath, importType: "fit-file" });
      await runImportJob(job, mockDb);
      expect(mockImportFitFile).toHaveBeenCalledWith(
        mockDb,
        {
          filePath: tempFilePath,
          originalPath: "uploaded.fit",
          userId: "user-1",
          providerId: "fit-file",
          sourceName: "FIT File",
        },
        expect.any(Function),
        expect.any(Object),
      );
      expect(mockEnsureProvider).toHaveBeenCalledWith(
        mockDb,
        "fit-file",
        "FIT File",
        undefined,
        "user-1",
      );
      expect(mockLogSync).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          providerId: "fit-file",
          dataType: "import",
          status: "success",
          recordCount: 1,
          userId: "user-1",
        }),
      );
      expect(mockEnqueueDebouncedPostSyncMaintenance).toHaveBeenCalledOnce();
      expect(mockEnqueueDebouncedUserRefit).toHaveBeenCalledWith("user-1");
    });
    it("forwards FIT progress and logs decoder errors", async () => {
      mockImportFitFile.mockImplementationOnce(
        async (
          _db: unknown,
          _data: unknown,
          onProgress: (info: { percentage: number; message: string }) => Promise<void>,
        ) => {
          await onProgress({ percentage: 50, message: "Importing FIT activity..." });
          return { recordsSynced: 0, errors: [{ message: "invalid FIT file" }] };
        },
      );
      const job = createMockJob({ filePath: tempFilePath, importType: "fit-file" });
      await runImportJob(job, mockDb);

      expect(job.updateProgress).toHaveBeenCalledWith({
        percentage: 50,
        message: "Importing FIT activity...",
      });
      expect(mockLogSync).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          providerId: "fit-file",
          status: "error",
          errorMessage: "invalid FIT file",
        }),
      );
    });
  });
  describe("file cleanup", () => {
    it("records a terminal skipped stage when erasure starts before ingest", async () => {
      mockIsAccountErasureActive.mockResolvedValueOnce(true);
      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });

      await runImportJob(job, mockDb);

      expect(mockAppendProcessingStageEvent).toHaveBeenCalledWith(mockDb, {
        operationId: processingOperationId,
        stage: "ingest",
        status: "skipped",
        errorMessage: "Import skipped because account deletion is active.",
        idempotencyKey: "worker-skipped-account-erasure",
      });
      expect(mockImportAppleHealthFile).not.toHaveBeenCalled();
      await expect(access(tempFilePath)).rejects.toThrow();
    });

    it("cleans up uploaded file after successful import", async () => {
      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await runImportJob(job, mockDb);
      await expect(access(tempFilePath)).rejects.toThrow();
    });
    it("cleans up uploaded file even when import fails", async () => {
      mockImportAppleHealthFile.mockRejectedValue(new Error("parse error"));
      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await expect(runImportJob(job, mockDb)).rejects.toThrow("parse error");

      await expect(access(tempFilePath)).rejects.toThrow();
      expect(mockAppendProcessingStageEvent).toHaveBeenCalledWith(mockDb, {
        operationId: processingOperationId,
        stage: "ingest",
        status: "failed",
        errorCode: "file_import_failed",
        errorMessage: "The file could not be imported. Check the file and try again.",
        idempotencyKey: "worker-failed",
      });
    });
    it("turns an invalid Apple Health archive into an unrecoverable import failure", async () => {
      const message =
        "Apple Health ZIP must contain export.xml; upload the original Apple Health export archive";
      mockImportAppleHealthFile.mockRejectedValueOnce(
        new MockAppleHealthImportValidationError(message),
      );
      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });

      await expect(runImportJob(job, mockDb)).rejects.toMatchObject({
        name: APPLE_HEALTH_IMPORT_VALIDATION_ERROR_NAME,
        message,
      });
      expect(mockAppendProcessingStageEvent).toHaveBeenCalledWith(mockDb, {
        operationId: processingOperationId,
        stage: "ingest",
        status: "failed",
        errorCode: "file_import_failed",
        errorMessage: message,
        idempotencyKey: "worker-failed",
      });
    });
    it("preserves the uploaded file when a persisted metric batch still needs publishing", async () => {
      mockMetricStreamPublishRows.mockRejectedValueOnce(new Error("broker unavailable"));
      mockImportAppleHealthFile.mockImplementationOnce(
        async (
          _database: unknown,
          _filePath: unknown,
          _since: unknown,
          _onProgress: unknown,
          metricStreamPublisher: {
            publishRows(
              rows: readonly MetricStreamRowInput[],
              options: MetricStreamPublishOptions,
            ): Promise<unknown>;
          },
        ) => {
          await metricStreamPublisher.publishRows(
            [
              {
                recordedAt: "2026-06-02T10:00:00.000Z",
                userId: "00000000-0000-4000-8000-000000000001",
                providerId: "apple_health",
                externalId: "heart-rate-retry",
                sourceType: "file",
                channel: "heart_rate",
                scalar: 72,
              },
            ],
            { operationRevision: "1000000000000000" },
          );
          return { recordsSynced: 1, errors: [] };
        },
      );
      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });

      await expect(runImportJob(job, mockDb)).rejects.toThrow("broker unavailable");

      await expect(access(tempFilePath)).resolves.toBeUndefined();
      expect(mockRecordMetricStreamBatchPublished).toHaveBeenCalledOnce();
      expect(mockUnlink).not.toHaveBeenCalled();
    });
    it("reports and propagates unlink failures so cleanup remains retryable", async () => {
      const cleanupError = new Error("EACCES: permission denied");
      mockUnlink.mockRejectedValueOnce(cleanupError);
      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await expect(runImportJob(job, mockDb)).rejects.toBe(cleanupError);
      expect(mockCaptureException).toHaveBeenCalledWith(cleanupError, {
        tags: { phase: "uploaded-file-cleanup" },
      });
      expect(mockAppendProcessingStageEvent).toHaveBeenCalledWith(mockDb, {
        operationId: processingOperationId,
        stage: "ingest",
        status: "failed",
        errorCode: "file_cleanup_failed",
        errorMessage: "The import finished, but its uploaded file could not be cleaned up.",
        idempotencyKey: "worker-failed",
      });
    });
    it("preserves both errors when import and cleanup fail", async () => {
      const importError = new Error("parse error");
      const cleanupError = new Error("EACCES: permission denied");
      mockImportAppleHealthFile.mockRejectedValueOnce(importError);
      mockUnlink.mockRejectedValueOnce(cleanupError);
      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });

      await expect(runImportJob(job, mockDb)).rejects.toEqual(
        expect.objectContaining({
          name: "AggregateError",
          errors: [importError, cleanupError],
        }),
      );
      expect(mockCaptureException).toHaveBeenCalledWith(cleanupError, {
        tags: { phase: "uploaded-file-cleanup" },
      });
    });
  });
  describe("processing output evidence", () => {
    it("records relational output after a non-empty import", async () => {
      await writeFile(tempFilePath, "csv data");
      const job = createMockJob({ filePath: tempFilePath, importType: "strong-csv" });

      await runImportJob(job, mockDb);

      expect(mockCreateProcessingOperation).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({ providerId: "strong-csv" }),
      );
      expect(mockRecordRelationalCanonicalCommits).toHaveBeenCalledWith(mockDb, {
        operationId: processingOperationId,
        datasetKeys: ["activity", "recovery", "training", "providers"],
        idempotencyKey: "worker-relational-commit:import-job-1",
      });
      expect(mockAppendProcessingStageEvent).not.toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({ status: "skipped" }),
      );
    });

    it("records exact analytics and cache skips when an import emits no output", async () => {
      mockImportCronometerCsv.mockResolvedValueOnce({ recordsSynced: 0, errors: [] });
      await writeFile(tempFilePath, "csv data");
      const job = createMockJob({ filePath: tempFilePath, importType: "cronometer-csv" });

      await runImportJob(job, mockDb);

      expect(mockRecordRelationalCanonicalCommits).not.toHaveBeenCalled();
      expect(mockAppendProcessingStageEvent.mock.calls).toEqual(
        expect.arrayContaining([
          [
            mockDb,
            {
              operationId: processingOperationId,
              stage: "analytics",
              status: "skipped",
              datasetKey: "nutrition",
              message: "No new data was emitted for this dataset",
              idempotencyKey: "no-output:nutrition:analytics",
            },
          ],
          [
            mockDb,
            {
              operationId: processingOperationId,
              stage: "cache_refresh",
              status: "skipped",
              datasetKey: "nutrition",
              message: "No new data was emitted for this dataset",
              idempotencyKey: "no-output:nutrition:cache_refresh",
            },
          ],
          [
            mockDb,
            {
              operationId: processingOperationId,
              stage: "analytics",
              status: "skipped",
              datasetKey: "providers",
              message: "No new data was emitted for this dataset",
              idempotencyKey: "no-output:providers:analytics",
            },
          ],
          [
            mockDb,
            {
              operationId: processingOperationId,
              stage: "cache_refresh",
              status: "skipped",
              datasetKey: "providers",
              message: "No new data was emitted for this dataset",
              idempotencyKey: "no-output:providers:cache_refresh",
            },
          ],
        ]),
      );
      expect(mockAppendProcessingStageEvent).toHaveBeenLastCalledWith(mockDb, {
        operationId: processingOperationId,
        stage: "ingest",
        status: "succeeded",
        progressPercentage: 100,
        errorCode: undefined,
        errorMessage: undefined,
        idempotencyKey: "worker-succeeded",
      });
    });
  });
  describe("post-import refresh", () => {
    it("enqueues debounced global maintenance and per-user refit", async () => {
      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await runImportJob(job, mockDb);

      expect(mockEnqueueDebouncedPostSyncMaintenance).toHaveBeenCalledOnce();
      expect(mockEnqueueDebouncedUserRefit).toHaveBeenCalledWith("user-1");
    });
    it("reports scheduling progress during post-import enqueue", async () => {
      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await runImportJob(job, mockDb);
      expect(job.updateProgress).toHaveBeenCalledWith({
        percentage: 95,
        message: "Scheduling post-import processing...",
      });
    });
    it("handles global maintenance enqueue failures gracefully", async () => {
      mockEnqueueDebouncedPostSyncMaintenance.mockRejectedValue(new Error("queue gone"));
      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await runImportJob(job, mockDb);

      expect(mockEnqueueDebouncedPostSyncMaintenance).toHaveBeenCalledOnce();
      expect(mockEnqueueDebouncedUserRefit).toHaveBeenCalledWith("user-1");
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to enqueue global post-import maintenance"),
      );
      expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
        tags: { phase: "post-import-global-maintenance-enqueue" },
      });
    });
    it("handles user refit enqueue failures gracefully", async () => {
      mockEnqueueDebouncedUserRefit.mockRejectedValue(new Error("queue gone"));
      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await runImportJob(job, mockDb);
      expect(mockEnqueueDebouncedPostSyncMaintenance).toHaveBeenCalledOnce();
      expect(mockEnqueueDebouncedUserRefit).toHaveBeenCalledWith("user-1");
      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to enqueue post-import user refit"),
      );
      expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
        tags: { phase: "post-import-user-refit-enqueue" },
      });
    });
  });
  describe("duration tracking", () => {
    it("computes correct durationMs for apple-health (kills Date.now arithmetic mutations)", async () => {
      let callCount = 0;
      const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
        // First call (importStart) = 10000, subsequent calls = 10500
        return callCount++ === 0 ? 10000 : 10500;
      });

      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await runImportJob(job, mockDb);
      const logCall = mockLogSync.mock.calls[0]?.[1];
      // durationMs = 10500 - 10000 = 500 (not 20500 if + was used)
      expect(logCall.durationMs).toBeLessThan(5000);
      expect(logCall.durationMs).toBeGreaterThanOrEqual(0);
      dateNowSpy.mockRestore();
    });
    it("computes correct duration string for apple-health log message", async () => {
      let callCount = 0;
      const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
        return callCount++ === 0 ? 10000 : 12000;
      });
      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await runImportJob(job, mockDb);

      // Duration = (12000 - 10000) / 1000 = 2.0s (not 2000000.0 if * was used)
      expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining("2.0s"));
      dateNowSpy.mockRestore();
    });
    it("computes correct duration for strong-csv import", async () => {
      let callCount = 0;
      const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
        return callCount++ === 0 ? 10000 : 13000;
      });
      await writeFile(tempFilePath, "csv data");
      const job = createMockJob({ filePath: tempFilePath, importType: "strong-csv" });
      await runImportJob(job, mockDb);
      expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining("3.0s"));
      const logCall = mockLogSync.mock.calls[0]?.[1];
      expect(logCall.durationMs).toBeLessThan(5000);

      dateNowSpy.mockRestore();
    });
    it("computes correct duration for cronometer-csv import", async () => {
      let callCount = 0;
      const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
        return callCount++ === 0 ? 10000 : 11500;
      });
      await writeFile(tempFilePath, "csv data");
      const job = createMockJob({ filePath: tempFilePath, importType: "cronometer-csv" });
      await runImportJob(job, mockDb);
      expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining("1.5s"));
      const logCall = mockLogSync.mock.calls[0]?.[1];
      expect(logCall.durationMs).toBeLessThan(5000);
      dateNowSpy.mockRestore();
    });
  });

  describe("handles undefined errors gracefully", () => {
    it("apple-health import with undefined errors logs success", async () => {
      mockImportAppleHealthFile.mockResolvedValue({
        recordsSynced: 5,
        errors: undefined,
      });
      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await runImportJob(job, mockDb);
      expect(mockLogSync).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({ status: "success", recordCount: 5 }),
      );
    });
  });
  describe("error counting", () => {
    it("reports correct error count for apple-health import with errors", async () => {
      mockImportAppleHealthFile.mockResolvedValue({
        recordsSynced: 5,
        errors: [{ message: "err1" }, { message: "err2" }, { message: "err3" }],
      });
      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await runImportJob(job, mockDb);

      // Logger info should contain error count
      expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining("3 errors"));
    });
    it("reports error status for strong-csv with errors", async () => {
      mockImportStrongCsv.mockResolvedValue({
        recordsSynced: 0,
        errors: [{ message: "parse error" }],
      });
      await writeFile(tempFilePath, "bad csv");
      const job = createMockJob({ filePath: tempFilePath, importType: "strong-csv" });
      await runImportJob(job, mockDb);
      expect(mockLogSync).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({ status: "error", errorMessage: "parse error" }),
      );
    });
    it("reports error status for cronometer-csv with errors", async () => {
      mockImportCronometerCsv.mockResolvedValue({
        recordsSynced: 0,
        errors: [{ message: "invalid format" }],
      });

      await writeFile(tempFilePath, "bad csv");
      const job = createMockJob({ filePath: tempFilePath, importType: "cronometer-csv" });
      await runImportJob(job, mockDb);
      expect(mockLogSync).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({ status: "error", errorMessage: "invalid format" }),
      );
    });
  });
});
