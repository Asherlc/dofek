import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock archiver
const mockArchive = {
  pipe: vi.fn(),
  append: vi.fn(),
  finalize: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
};
vi.mock("archiver", () => ({
  default: vi.fn(() => mockArchive),
}));

// Mock fs
const mockWriteStream = {
  on: vi.fn(),
};
vi.mock("node:fs", () => ({
  createWriteStream: vi.fn(() => mockWriteStream),
}));

// Mock logger
vi.mock("./logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import type { SyncDatabase } from "./db/index.ts";
import { generateExport } from "./export.ts";

// All DB functions are mocked — only execute is actually called by generateExport.
const mockDb: SyncDatabase = {
  select: vi.fn(),
  insert: vi.fn(),
  delete: vi.fn(),
  execute: vi.fn(),
};

function setupMockDb(executeResults: Record<string, unknown>[][] = []) {
  let callIndex = 0;
  const execute = vi.fn(() => {
    const result = executeResults[callIndex] ?? [];
    callIndex++;
    return Promise.resolve(result);
  });
  // Replace execute on the mock — Object.defineProperty avoids type mismatch
  Object.defineProperty(mockDb, "execute", { value: execute, writable: true });
}

describe("generateExport", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Make archive.on("error") and output.on("close"/"error") work
    // Simulate: output emits "close" after archive.finalize()
    mockWriteStream.on.mockImplementation((event: string, cb: () => void) => {
      if (event === "close") {
        // Resolve close immediately when finalize is called
        setTimeout(cb, 0);
      }
      return mockWriteStream;
    });
    mockArchive.on.mockReturnValue(mockArchive);
    mockArchive.finalize.mockResolvedValue(undefined);
  });

  it("exports all tables and returns result with counts", async () => {
    // 17 tables in EXPORT_TABLES, last one is batched (metric-streams)
    // For non-batched: 16 calls returning rows
    // For batched: 1 count query + batched stream reads
    const rows = [{ id: "1" }];
    const executeResults: Record<string, unknown>[][] = [];
    // 16 non-batched tables each return 1 row
    for (let i = 0; i < 16; i++) {
      executeResults.push(rows);
    }
    // metric-streams count query
    executeResults.push([{ count: "3" }]);
    // metric-streams batch query (called by the stream)
    executeResults.push([{ id: "ms1" }, { id: "ms2" }, { id: "ms3" }]);
    // second batch read returns empty (end of data)
    executeResults.push([]);

    setupMockDb(executeResults);
    const progress: Array<{ percentage: number; message: string }> = [];

    // For the batched stream, we need to handle archive.append receiving a Readable
    // and the test needs the stream to emit "end"
    mockArchive.append.mockImplementation((content: unknown, _opts: unknown) => {
      if (content instanceof Readable) {
        // Consume the stream so it finishes
        content.on("data", () => {});
        // The stream will emit "end" naturally once done
      }
    });

    const result = await generateExport(mockDb, "user-1", "/tmp/test.zip", (info) => {
      progress.push(info);
    });

    expect(result.tableCount).toBe(17);
    // 16 non-batched tables * 1 row each + 3 from batched count
    expect(result.totalRecords).toBe(19);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toEqual({ percentage: 100, message: "Export complete" });
  });

  it("handles empty tables correctly", async () => {
    const executeResults: Record<string, unknown>[][] = [];
    // 16 non-batched tables returning empty
    for (let i = 0; i < 16; i++) {
      executeResults.push([]);
    }
    // metric-streams count query
    executeResults.push([{ count: "0" }]);
    // metric-streams batch (empty)
    executeResults.push([]);

    setupMockDb(executeResults);

    mockArchive.append.mockImplementation((content: unknown, _opts: unknown) => {
      if (content instanceof Readable) {
        content.on("data", () => {});
      }
    });

    const result = await generateExport(mockDb, "user-1", "/tmp/test.zip", () => {});

    expect(result.tableCount).toBe(17);
    expect(result.totalRecords).toBe(0);
  });

  it("reports progress for each table", async () => {
    const executeResults: Record<string, unknown>[][] = [];
    for (let i = 0; i < 16; i++) {
      executeResults.push([]);
    }
    executeResults.push([{ count: "0" }]);
    executeResults.push([]);

    setupMockDb(executeResults);
    const progress: Array<{ percentage: number; message: string }> = [];

    mockArchive.append.mockImplementation((content: unknown, _opts: unknown) => {
      if (content instanceof Readable) {
        content.on("data", () => {});
      }
    });

    await generateExport(mockDb, "user-1", "/tmp/test.zip", (info) => {
      progress.push(info);
    });

    // Should have progress for each of the 17 tables + final 100%
    expect(progress.length).toBe(18);
    // First progress should be 0%
    expect(progress[0]?.percentage).toBe(0);
    expect(progress[0]?.message).toContain("Exporting");
    // Last progress should be 100%
    expect(progress[17]?.percentage).toBe(100);
  });

  it("includes metadata file in the archive", async () => {
    const executeResults: Record<string, unknown>[][] = [];
    for (let i = 0; i < 16; i++) {
      executeResults.push([]);
    }
    executeResults.push([{ count: "0" }]);
    executeResults.push([]);

    setupMockDb(executeResults);

    mockArchive.append.mockImplementation((content: unknown, _opts: unknown) => {
      if (content instanceof Readable) {
        content.on("data", () => {});
      }
    });

    await generateExport(mockDb, "user-1", "/tmp/test.zip", () => {});

    // Find the metadata append call
    const metadataCall = mockArchive.append.mock.calls.find(
      (call: unknown[]) =>
        call[1] != null &&
        typeof call[1] === "object" &&
        "name" in call[1] &&
        call[1].name === "export-metadata.json",
    );
    expect(metadataCall).toBeDefined();

    const metadata = JSON.parse(String(metadataCall?.[0]));
    expect(metadata.userId).toBe("user-1");
    expect(metadata.tables).toHaveLength(17);
    expect(metadata.totalRecords).toBe(0);
    expect(metadata.exportedAt).toBeDefined();
  });
});
