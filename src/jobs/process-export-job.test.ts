import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../db/index.ts";
import type { ExportJobData } from "./queues.ts";

vi.mock("../logger.ts", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockGenerateExport = vi.fn().mockResolvedValue({ tableCount: 5, totalRecords: 100 });
vi.mock("../export.ts", () => ({
  generateExport: (...args: unknown[]) => mockGenerateExport(...args),
}));

const { processExportJob } = await import("./process-export-job.ts");

const mockDb: SyncDatabase = {
  select: vi.fn(),
  insert: vi.fn(),
  delete: vi.fn(),
  execute: vi.fn(),
};

interface MockJob {
  data: ExportJobData;
  updateProgress: ReturnType<typeof vi.fn>;
}

function createMockJob(overrides: Partial<ExportJobData> = {}): MockJob {
  return {
    data: {
      userId: "user-1",
      outputPath: "/app/job-files/dofek-export-abc.zip",
      ...overrides,
    },
    updateProgress: vi.fn().mockResolvedValue(undefined),
  };
}

describe("processExportJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateExport.mockResolvedValue({ tableCount: 5, totalRecords: 100 });
  });

  it("calls generateExport with correct arguments", async () => {
    const job = createMockJob();
    await processExportJob(job, mockDb);

    expect(mockGenerateExport).toHaveBeenCalledWith(
      mockDb,
      "user-1",
      "/app/job-files/dofek-export-abc.zip",
      expect.any(Function),
    );
  });

  it("forwards progress updates to job.updateProgress", async () => {
    mockGenerateExport.mockImplementation(
      async (
        _db: unknown,
        _userId: string,
        _path: string,
        onProgress: (info: { percentage: number; message: string }) => void,
      ) => {
        onProgress({ percentage: 25, message: "Exporting activities.json..." });
        onProgress({ percentage: 75, message: "Exporting sleep-sessions.json..." });
        return { tableCount: 5, totalRecords: 100 };
      },
    );

    const job = createMockJob();
    await processExportJob(job, mockDb);

    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 25,
      message: "Exporting activities.json...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 75,
      message: "Exporting sleep-sessions.json...",
    });
  });

  it("propagates errors from generateExport", async () => {
    mockGenerateExport.mockRejectedValue(new Error("DB connection failed"));

    const job = createMockJob();
    await expect(processExportJob(job, mockDb)).rejects.toThrow("DB connection failed");
  });

  it("does not swallow updateProgress failures", async () => {
    mockGenerateExport.mockImplementation(
      async (
        _db: unknown,
        _userId: string,
        _path: string,
        onProgress: (info: { percentage: number; message: string }) => void,
      ) => {
        onProgress({ percentage: 50, message: "test" });
        return { tableCount: 5, totalRecords: 100 };
      },
    );

    // updateProgress rejects but the export should still complete (catch in the callback)
    const job = createMockJob();
    job.updateProgress.mockRejectedValue(new Error("Redis down"));

    await processExportJob(job, mockDb);
    expect(mockGenerateExport).toHaveBeenCalled();
  });
});
