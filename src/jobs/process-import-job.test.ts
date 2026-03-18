import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../db/index.ts";
import type { ImportJobData } from "./queues.ts";

// Mock dependencies with module-level mock functions (avoids `as` casts)
const mockLogSync = vi.fn().mockResolvedValue(undefined);
vi.mock("../db/sync-log.ts", () => ({
  logSync: (...args: unknown[]) => mockLogSync(...args),
}));

const mockUpdateUserMaxHr = vi.fn().mockResolvedValue(undefined);
const mockRefreshDedupViews = vi.fn().mockResolvedValue(undefined);
vi.mock("../db/dedup.ts", () => ({
  updateUserMaxHr: (...args: unknown[]) => mockUpdateUserMaxHr(...args),
  refreshDedupViews: (...args: unknown[]) => mockRefreshDedupViews(...args),
}));

const mockLoadPriorityConfig = vi.fn().mockReturnValue(null);
const mockSyncProviderPriorities = vi.fn().mockResolvedValue(undefined);
vi.mock("../db/provider-priority.ts", () => ({
  loadProviderPriorityConfig: (...args: unknown[]) => mockLoadPriorityConfig(...args),
  syncProviderPriorities: (...args: unknown[]) => mockSyncProviderPriorities(...args),
}));

const mockImportAppleHealthFile = vi.fn().mockResolvedValue({
  recordsSynced: 42,
  errors: [],
});
vi.mock("../providers/apple-health/index.ts", () => ({
  importAppleHealthFile: (...args: unknown[]) => mockImportAppleHealthFile(...args),
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

// Import after mocks
const { processImportJob } = await import("./process-import-job.ts");

// All DB functions are mocked at module level, so the db object is never actually called.
const mockDb: SyncDatabase = {
  select: vi.fn(),
  insert: vi.fn(),
  delete: vi.fn(),
  execute: vi.fn(),
};

interface MockJob {
  data: ImportJobData;
  updateProgress: ReturnType<typeof vi.fn>;
}

function createMockJob(overrides: Partial<ImportJobData> = {}): MockJob {
  return {
    data: {
      filePath: "/tmp/test-upload.zip",
      since: "2024-01-01T00:00:00.000Z",
      userId: "user-1",
      importType: "apple-health",
      ...overrides,
    },
    updateProgress: vi.fn().mockResolvedValue(undefined),
  };
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

    // Create a real temp file so unlink doesn't fail
    tempFilePath = join(tmpdir(), `test-import-${Date.now()}.tmp`);
    await writeFile(tempFilePath, "test data");

    // Restore default return values after clearAllMocks
    mockLogSync.mockResolvedValue(undefined);
    mockUpdateUserMaxHr.mockResolvedValue(undefined);
    mockRefreshDedupViews.mockResolvedValue(undefined);
    mockImportAppleHealthFile.mockResolvedValue({ recordsSynced: 42, errors: [] });
    mockImportStrongCsv.mockResolvedValue({ recordsSynced: 10, errors: [] });
    mockImportCronometerCsv.mockResolvedValue({ recordsSynced: 7, errors: [] });
    mockLoadPriorityConfig.mockReturnValue(null);
    mockSyncProviderPriorities.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("apple-health import", () => {
    it("calls importAppleHealthFile with correct args and reports progress", async () => {
      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await runImportJob(job, mockDb);

      expect(mockImportAppleHealthFile).toHaveBeenCalledWith(
        mockDb,
        tempFilePath,
        new Date("2024-01-01T00:00:00.000Z"),
        expect.any(Function),
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

    it("updates progress via the callback", async () => {
      mockImportAppleHealthFile.mockImplementation(
        async (
          _db: unknown,
          _path: unknown,
          _since: unknown,
          onProgress: (info: { pct: number }) => void,
        ) => {
          onProgress({ pct: 50 });
          return { recordsSynced: 10, errors: [] };
        },
      );

      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await runImportJob(job, mockDb);

      expect(job.updateProgress).toHaveBeenCalledWith({
        pct: 50,
        message: "Processing: 50%",
      });
    });

    it("only logs progress at 10% increments", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      mockImportAppleHealthFile.mockImplementation(
        async (
          _db: unknown,
          _path: unknown,
          _since: unknown,
          onProgress: (info: { pct: number }) => void,
        ) => {
          onProgress({ pct: 5 });
          onProgress({ pct: 9 });
          onProgress({ pct: 10 });
          onProgress({ pct: 15 });
          onProgress({ pct: 20 });
          return { recordsSynced: 10, errors: [] };
        },
      );

      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await runImportJob(job, mockDb);

      // Should log at 10% and 20%, but not at 5%, 9%, or 15%
      const progressLogs = consoleSpy.mock.calls.filter((call) =>
        String(call[0]).includes("progress"),
      );
      expect(progressLogs).toHaveLength(2);
      expect(String(progressLogs.at(0))).toContain("10%");
      expect(String(progressLogs.at(1))).toContain("20%");
      consoleSpy.mockRestore();
    });

    it("logs completion message with record count", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await runImportJob(job, mockDb);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Apple Health import complete"),
      );
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("42 records imported"));
      consoleSpy.mockRestore();
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
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

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
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Strong CSV import complete"),
      );
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("10 workouts imported"));
      consoleSpy.mockRestore();
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
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

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
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Cronometer CSV import complete"),
      );
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("7 food entries imported"));
      consoleSpy.mockRestore();
    });
  });

  describe("file cleanup", () => {
    it("cleans up uploaded file after successful import", async () => {
      const { access } = await import("node:fs/promises");

      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await runImportJob(job, mockDb);

      await expect(access(tempFilePath)).rejects.toThrow();
    });

    it("cleans up uploaded file even when import fails", async () => {
      const { access } = await import("node:fs/promises");

      mockImportAppleHealthFile.mockRejectedValue(new Error("parse error"));

      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await expect(runImportJob(job, mockDb)).rejects.toThrow("parse error");

      await expect(access(tempFilePath)).rejects.toThrow();
    });
  });

  describe("post-import refresh", () => {
    it("calls updateUserMaxHr and refreshDedupViews", async () => {
      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await runImportJob(job, mockDb);

      expect(mockUpdateUserMaxHr).toHaveBeenCalledWith(mockDb);
      expect(mockRefreshDedupViews).toHaveBeenCalledWith(mockDb);
    });

    it("handles post-import refresh failures gracefully and logs errors", async () => {
      mockUpdateUserMaxHr.mockRejectedValue(new Error("db gone"));
      mockRefreshDedupViews.mockRejectedValue(new Error("db gone"));
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      // Should not throw
      await runImportJob(job, mockDb);

      expect(mockUpdateUserMaxHr).toHaveBeenCalled();
      expect(mockRefreshDedupViews).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to update max HR"));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to refresh views"));
      consoleSpy.mockRestore();
    });

    it("syncs provider priorities before refreshing views", async () => {
      const fakeConfig = { providers: { wahoo: { activity: 10 } } };
      mockLoadPriorityConfig.mockReturnValue(fakeConfig);

      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await runImportJob(job, mockDb);

      expect(mockLoadPriorityConfig).toHaveBeenCalled();
      expect(mockSyncProviderPriorities).toHaveBeenCalledWith(mockDb, fakeConfig);
    });

    it("skips priority sync when config is null", async () => {
      mockLoadPriorityConfig.mockReturnValue(null);

      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await runImportJob(job, mockDb);

      expect(mockLoadPriorityConfig).toHaveBeenCalled();
      expect(mockSyncProviderPriorities).not.toHaveBeenCalled();
    });

    it("handles priority sync errors gracefully", async () => {
      mockLoadPriorityConfig.mockImplementation(() => {
        throw new Error("config read failed");
      });
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await runImportJob(job, mockDb);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("provider priorities"));
      consoleSpy.mockRestore();
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
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await runImportJob(job, mockDb);

      // Duration = (12000 - 10000) / 1000 = 2.0s (not 2000000.0 if * was used)
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("2.0s"));

      dateNowSpy.mockRestore();
      consoleSpy.mockRestore();
    });

    it("computes correct duration for strong-csv import", async () => {
      let callCount = 0;
      const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
        return callCount++ === 0 ? 10000 : 13000;
      });
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await writeFile(tempFilePath, "csv data");
      const job = createMockJob({ filePath: tempFilePath, importType: "strong-csv" });
      await runImportJob(job, mockDb);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("3.0s"));
      const logCall = mockLogSync.mock.calls[0]?.[1];
      expect(logCall.durationMs).toBeLessThan(5000);

      dateNowSpy.mockRestore();
      consoleSpy.mockRestore();
    });

    it("computes correct duration for cronometer-csv import", async () => {
      let callCount = 0;
      const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
        return callCount++ === 0 ? 10000 : 11500;
      });
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await writeFile(tempFilePath, "csv data");
      const job = createMockJob({ filePath: tempFilePath, importType: "cronometer-csv" });
      await runImportJob(job, mockDb);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("1.5s"));
      const logCall = mockLogSync.mock.calls[0]?.[1];
      expect(logCall.durationMs).toBeLessThan(5000);

      dateNowSpy.mockRestore();
      consoleSpy.mockRestore();
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

      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const job = createMockJob({ filePath: tempFilePath, importType: "apple-health" });
      await runImportJob(job, mockDb);

      // Console log should contain error count
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("3 errors"));
      consoleSpy.mockRestore();
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
