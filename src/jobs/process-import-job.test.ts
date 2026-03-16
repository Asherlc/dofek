import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const mockImportAppleHealthFile = vi.fn().mockResolvedValue({
  recordsSynced: 42,
  errors: [],
});
vi.mock("../providers/apple-health.ts", () => ({
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

const mockDb = Object.create(null);

interface MockJob {
  data: Record<string, unknown>;
  updateProgress: ReturnType<typeof vi.fn>;
}

function createMockJob(overrides: Record<string, unknown> = {}): MockJob {
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

// Helper to call processImportJob with a mock job without needing `as` casts.
// processImportJob expects a full BullMQ Job but only uses .data and .updateProgress.
function runImportJob(job: MockJob, db: unknown) {
  return processImportJob(
    // @ts-expect-error -- mock job only implements the subset of Job used by processImportJob
    job,
    db,
  );
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
  });
});
