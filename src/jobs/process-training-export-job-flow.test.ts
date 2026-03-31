import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock fs before importing the module under test
vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("../lib/typed-sql.ts", () => ({
  executeWithSchema: vi.fn(),
}));

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

// Mock the DuckDB writeParquet function
vi.mock("@duckdb/node-bindings", () => ({
  open: vi.fn().mockResolvedValue({ __duckdb_type: "duckdb_database" }),
  connect: vi.fn().mockResolvedValue({ __duckdb_type: "duckdb_connection" }),
  query: vi.fn().mockResolvedValue({ __duckdb_type: "duckdb_result" }),
  appender_create: vi.fn().mockReturnValue({ __duckdb_type: "duckdb_appender" }),
  append_varchar: vi.fn(),
  append_double: vi.fn(),
  append_null: vi.fn(),
  append_value: vi.fn(),
  appender_end_row: vi.fn(),
  appender_flush_sync: vi.fn(),
  appender_close_sync: vi.fn(),
  disconnect_sync: vi.fn(),
  close_sync: vi.fn(),
  create_varchar: vi.fn().mockReturnValue({ __duckdb_type: "duckdb_value" }),
}));

import { mkdirSync, writeFileSync } from "node:fs";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { processTrainingExportJob } from "./process-training-export-job.ts";

const mockExecuteWithSchema = vi.mocked(executeWithSchema);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);

function createMockJob(data: { since?: string; until?: string } = {}) {
  return {
    data,
    updateProgress: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockDb(): Parameters<typeof processTrainingExportJob>[1] {
  // The DB is fully mocked via vi.mock("../lib/typed-sql.ts")
  // so the actual object doesn't matter — executeWithSchema is intercepted.
  return Object.create(null);
}

describe("processTrainingExportJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exports sensor_sample data when rows exist", async () => {
    const job = createMockJob();
    const db = createMockDb();

    // Call sequence:
    // 1. sensor_sample COUNT
    // 2. sensor_sample rows batch 1
    mockExecuteWithSchema.mockResolvedValueOnce([{ count: "2" }]).mockResolvedValueOnce([
      {
        recorded_at: "2026-03-30T15:00:00Z",
        user_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        provider_id: "wahoo",
        device_id: null,
        source_type: "ble",
        channel: "heart_rate",
        activity_id: null,
        activity_type: "cycling",
        scalar: 142,
        vector: null,
      },
      {
        recorded_at: "2026-03-30T15:00:00.020Z",
        user_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        provider_id: "apple_health",
        device_id: "Apple Watch",
        source_type: "ble",
        channel: "imu",
        activity_id: null,
        activity_type: null,
        scalar: null,
        vector: [0.012, 0.138, -0.987],
      },
    ]);

    await processTrainingExportJob(job, db);

    // Should create directories
    expect(mockMkdirSync).toHaveBeenCalled();

    // Should write manifest (Parquet is written by DuckDB, not writeFileSync)
    expect(mockWriteFileSync).toHaveBeenCalledTimes(1); // manifest only

    // Should update progress
    expect(job.updateProgress).toHaveBeenCalled();

    // Manifest should be valid JSON with one file
    const manifestCall = mockWriteFileSync.mock.calls.find((call) =>
      String(call[0]).includes("manifest.json"),
    );
    expect(manifestCall).toBeDefined();
    const manifest = JSON.parse(String(manifestCall?.[1]));
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0].table).toBe("sensor_sample");
    expect(manifest.files[0].path).toContain(".parquet");
    expect(manifest.totalRows).toBe(2);
  });

  it("handles zero rows gracefully", async () => {
    const job = createMockJob();
    const db = createMockDb();

    mockExecuteWithSchema.mockResolvedValueOnce([{ count: "0" }]);

    await processTrainingExportJob(job, db);

    const manifestCall = mockWriteFileSync.mock.calls.find((call) =>
      String(call[0]).includes("manifest.json"),
    );
    const manifest = JSON.parse(String(manifestCall?.[1]));
    expect(manifest.files).toHaveLength(0);
    expect(manifest.totalRows).toBe(0);
  });

  it("passes since and until to manifest", async () => {
    const job = createMockJob({ since: "2026-03-01T00:00:00Z", until: "2026-03-31T00:00:00Z" });
    const db = createMockDb();

    mockExecuteWithSchema.mockResolvedValueOnce([{ count: "0" }]);

    await processTrainingExportJob(job, db);

    const manifestCall = mockWriteFileSync.mock.calls.find((call) =>
      String(call[0]).includes("manifest.json"),
    );
    const manifest = JSON.parse(String(manifestCall?.[1]));
    expect(manifest.since).toBe("2026-03-01T00:00:00Z");
    expect(manifest.until).toBe("2026-03-31T00:00:00Z");
  });

  it("reports progress through the job", async () => {
    const job = createMockJob();
    const db = createMockDb();

    mockExecuteWithSchema.mockResolvedValueOnce([{ count: "0" }]);

    await processTrainingExportJob(job, db);

    // Should report start and completion
    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ percentage: 0 }));
    expect(job.updateProgress).toHaveBeenCalledWith(expect.objectContaining({ percentage: 100 }));
  });
});
