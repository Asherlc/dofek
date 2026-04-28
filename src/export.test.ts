import { Readable } from "node:stream";
import archiver from "archiver";
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

function findArchiveEntry(name: string): unknown[] | undefined {
  return mockArchive.append.mock.calls.find(
    (call: unknown[]) =>
      call[1] != null && typeof call[1] === "object" && "name" in call[1] && call[1].name === name,
  );
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
    // 18 tables in EXPORT_TABLES, last one is batched (metric-streams)
    // For non-batched: 17 calls returning rows
    // For batched: 1 count query + batched stream reads
    const rows = [{ id: "1" }];
    const executeResults: Record<string, unknown>[][] = [];
    // 17 non-batched tables each return 1 row
    for (let i = 0; i < 17; i++) {
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

    expect(result.tableCount).toBe(18);
    // 17 non-batched tables * 1 row each + 3 from batched count
    expect(result.totalRecords).toBe(20);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toEqual({ percentage: 100, message: "Export complete" });
  });

  it("handles empty tables correctly", async () => {
    const executeResults: Record<string, unknown>[][] = [];
    // 17 non-batched tables returning empty
    for (let i = 0; i < 17; i++) {
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

    expect(result.tableCount).toBe(18);
    expect(result.totalRecords).toBe(0);
  });

  it("reports progress for each table", async () => {
    const executeResults: Record<string, unknown>[][] = [];
    for (let i = 0; i < 17; i++) {
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

    // Should have progress for each of the 18 tables + final 100%
    expect(progress.length).toBe(19);
    // First progress should be 0%
    expect(progress[0]?.percentage).toBe(0);
    expect(progress[0]?.message).toContain("Exporting");
    expect(progress[1]?.percentage).toBe(6);
    expect(progress[9]?.percentage).toBe(50);
    // Last progress should be 100%
    expect(progress[18]?.percentage).toBe(100);
  });

  it("includes metadata file in the archive", async () => {
    const executeResults: Record<string, unknown>[][] = [];
    for (let i = 0; i < 17; i++) {
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
    expect(metadata.tables).toHaveLength(18);
    expect(metadata.tables[0]).toBe("user-profile.csv");
    expect(metadata.tables).toContain("metric-streams.csv");
    expect(metadata.totalRecords).toBe(0);
    expect(metadata.exportedAt).toBeDefined();
  });

  it("creates a compressed ZIP archive", async () => {
    const executeResults: Record<string, unknown>[][] = [];
    for (let tableIndex = 0; tableIndex < 17; tableIndex++) {
      executeResults.push([]);
    }
    executeResults.push([{ count: "0" }]);
    executeResults.push([]);

    setupMockDb(executeResults);
    mockArchive.append.mockImplementation((content: unknown) => {
      if (content instanceof Readable) {
        content.on("data", () => {});
      }
    });

    await generateExport(mockDb, "user-1", "/tmp/test.zip", () => {});

    expect(archiver).toHaveBeenCalledWith("zip", { zlib: { level: 6 } });
  });

  it("writes empty CSV files for empty regular tables", async () => {
    const executeResults: Record<string, unknown>[][] = [];
    for (let tableIndex = 0; tableIndex < 17; tableIndex++) {
      executeResults.push([]);
    }
    executeResults.push([{ count: "0" }]);
    executeResults.push([]);

    setupMockDb(executeResults);
    mockArchive.append.mockImplementation((content: unknown) => {
      if (content instanceof Readable) {
        content.on("data", () => {});
      }
    });

    await generateExport(mockDb, "user-1", "/tmp/test.zip", () => {});

    const userProfileEntry = findArchiveEntry("user-profile.csv");
    expect(userProfileEntry).toBeDefined();
    expect(userProfileEntry?.[0]).toBe("");
  });

  it("exports regular tables as CSV files with escaped cells", async () => {
    const executeResults: Record<string, unknown>[][] = [
      [
        {
          id: "user-1",
          name: "Alice, Athlete",
          notes: "Line 1\nLine 2",
          quote: 'She said "go"',
          raw: { source: "test", values: [1, 2] },
          missing: null,
        },
      ],
    ];
    for (let tableIndex = 1; tableIndex < 18; tableIndex++) {
      executeResults.push([]);
    }
    executeResults.push([{ count: "0" }]);
    executeResults.push([]);

    setupMockDb(executeResults);
    mockArchive.append.mockImplementation((content: unknown) => {
      if (content instanceof Readable) {
        content.on("data", () => {});
      }
    });

    await generateExport(mockDb, "user-1", "/tmp/test.zip", () => {});

    const userProfileEntry = findArchiveEntry("user-profile.csv");
    expect(userProfileEntry).toBeDefined();
    expect(String(userProfileEntry?.[0])).toBe(
      'id,name,notes,quote,raw,missing\nuser-1,"Alice, Athlete","Line 1\nLine 2","She said ""go""","{""source"":""test"",""values"":[1,2]}",',
    );
    expect(findArchiveEntry("user-profile.json")).toBeUndefined();
  });

  it("streams metric streams as CSV", async () => {
    const executeResults: Record<string, unknown>[][] = [];
    for (let tableIndex = 0; tableIndex < 17; tableIndex++) {
      executeResults.push([]);
    }
    executeResults.push([{ count: "2" }]);
    executeResults.push([
      {
        recorded_at: new Date("2024-01-15T10:00:00.000Z"),
        provider_id: "test-provider",
        source_type: "api",
        channel: "heart_rate",
        scalar: 145,
      },
      {
        recorded_at: new Date("2024-01-15T10:00:01.000Z"),
        provider_id: "test-provider",
        source_type: "api",
        channel: "power",
        scalar: 200,
      },
    ]);

    setupMockDb(executeResults);
    let metricStreamContent: Promise<string> | undefined;
    mockArchive.append.mockImplementation((content: unknown, options: unknown) => {
      if (
        content instanceof Readable &&
        options != null &&
        typeof options === "object" &&
        "name" in options &&
        options.name === "metric-streams.csv"
      ) {
        const chunks: string[] = [];
        metricStreamContent = new Promise((resolve, reject) => {
          content.on("data", (chunk) => chunks.push(String(chunk)));
          content.on("end", () => resolve(chunks.join("")));
          content.on("error", reject);
        });
      } else if (content instanceof Readable) {
        content.on("data", () => {});
      }
    });

    await generateExport(mockDb, "user-1", "/tmp/test.zip", () => {});

    expect(metricStreamContent).toBeDefined();
    if (!metricStreamContent) throw new Error("Expected metric-streams.csv stream");
    await expect(metricStreamContent).resolves.toBe(
      "recorded_at,provider_id,source_type,channel,scalar\n2024-01-15T10:00:00.000Z,test-provider,api,heart_rate,145\n2024-01-15T10:00:01.000Z,test-provider,api,power,200",
    );
  });

  it("streams metric streams across multiple cursor batches", async () => {
    const executeResults: Record<string, unknown>[][] = [];
    for (let tableIndex = 0; tableIndex < 17; tableIndex++) {
      executeResults.push([]);
    }
    executeResults.push([{ count: "50001" }]);
    executeResults.push(
      Array.from({ length: 50_000 }, (_, index) => ({
        recorded_at: new Date(1_704_108_000_000 + index * 1000),
        provider_id: "test-provider",
        source_type: "api",
        channel: "heart_rate",
        scalar: index,
      })),
    );
    executeResults.push([
      {
        recorded_at: new Date("2024-01-02T00:00:00.000Z"),
        provider_id: "test-provider",
        source_type: "api",
        channel: "heart_rate",
        scalar: 50_000,
      },
    ]);

    setupMockDb(executeResults);
    let metricStreamContent = "";
    mockArchive.append.mockImplementation((content: unknown, options: unknown) => {
      if (
        content instanceof Readable &&
        options != null &&
        typeof options === "object" &&
        "name" in options &&
        options.name === "metric-streams.csv"
      ) {
        content.on("data", (chunk) => {
          metricStreamContent += String(chunk);
        });
      } else if (content instanceof Readable) {
        content.on("data", () => {});
      }
    });

    const result = await generateExport(mockDb, "user-1", "/tmp/test.zip", () => {});

    expect(result.totalRecords).toBe(50_001);
    expect(
      metricStreamContent.startsWith("recorded_at,provider_id,source_type,channel,scalar\n"),
    ).toBe(true);
    expect(metricStreamContent).toContain(",0\n");
    expect(metricStreamContent.endsWith(",50000")).toBe(true);
    expect(vi.mocked(mockDb.execute)).toHaveBeenCalledTimes(20);
  });
});
