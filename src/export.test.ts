import { ZipArchive } from "archiver";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock Archiver
const mockArchive = {
  pipe: vi.fn(),
  append: vi.fn(),
  finalize: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
};
vi.mock("archiver", () => ({
  ZipArchive: vi.fn(function vitestConstructor() {
    return mockArchive;
  }),
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

const TEST_USER_ID = "user-1";

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
    const rows = [{ id: "1" }];
    const executeResults: Record<string, unknown>[][] = [];
    for (let i = 0; i < 17; i++) {
      executeResults.push(rows);
    }

    setupMockDb(executeResults);
    const progress: Array<{ percentage: number; message: string }> = [];

    const result = await generateExport(mockDb, "user-1", "/tmp/test.zip", (info) => {
      progress.push(info);
    });

    expect(result.tableCount).toBe(17);
    expect(result.totalRecords).toBe(17);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toEqual({ percentage: 100, message: "Export complete" });
  });

  it("handles empty tables correctly", async () => {
    const executeResults: Record<string, unknown>[][] = [];
    for (let i = 0; i < 17; i++) {
      executeResults.push([]);
    }

    setupMockDb(executeResults);

    const result = await generateExport(mockDb, "user-1", "/tmp/test.zip", () => {});

    expect(result.tableCount).toBe(17);
    expect(result.totalRecords).toBe(0);
  });

  it("reports progress for each table", async () => {
    const executeResults: Record<string, unknown>[][] = [];
    for (let i = 0; i < 17; i++) {
      executeResults.push([]);
    }

    setupMockDb(executeResults);
    const progress: Array<{ percentage: number; message: string }> = [];

    await generateExport(mockDb, "user-1", "/tmp/test.zip", (info) => {
      progress.push(info);
    });

    // Should have progress for each of the 17 tables + final 100%
    expect(progress.length).toBe(18);
    // First progress should be 0%
    expect(progress[0]?.percentage).toBe(0);
    expect(progress[0]?.message).toContain("Exporting");
    expect(progress[1]?.percentage).toBe(6);
    expect(progress[9]?.percentage).toBe(53);
    // Last progress should be 100%
    expect(progress[17]?.percentage).toBe(100);
  });

  it("includes metadata file in the archive", async () => {
    const executeResults: Record<string, unknown>[][] = [];
    for (let i = 0; i < 17; i++) {
      executeResults.push([]);
    }

    setupMockDb(executeResults);

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
    expect(metadata.tables[0]).toBe("user-profile.csv");
    expect(metadata.tables).toContain("breathwork-sessions.csv");
    expect(metadata.tables).toContain("menstrual-periods.csv");
    expect(metadata.tables).not.toContain("metric-streams.csv");
    expect(metadata.totalRecords).toBe(0);
    expect(metadata.exportedAt).toBeDefined();
  });

  it("creates a compressed ZIP archive", async () => {
    const executeResults: Record<string, unknown>[][] = [];
    for (let tableIndex = 0; tableIndex < 17; tableIndex++) {
      executeResults.push([]);
    }

    setupMockDb(executeResults);

    await generateExport(mockDb, "user-1", "/tmp/test.zip", () => {});

    expect(ZipArchive).toHaveBeenCalledWith({ zlib: { level: 6 } });
  });

  it("writes empty CSV files for empty regular tables", async () => {
    const executeResults: Record<string, unknown>[][] = [];
    for (let tableIndex = 0; tableIndex < 17; tableIndex++) {
      executeResults.push([]);
    }

    setupMockDb(executeResults);

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
    for (let tableIndex = 1; tableIndex < 17; tableIndex++) {
      executeResults.push([]);
    }

    setupMockDb(executeResults);

    await generateExport(mockDb, "user-1", "/tmp/test.zip", () => {});

    const userProfileEntry = findArchiveEntry("user-profile.csv");
    expect(userProfileEntry).toBeDefined();
    expect(String(userProfileEntry?.[0])).toBe(
      'id,name,notes,quote,raw,missing\nuser-1,"Alice, Athlete","Line 1\nLine 2","She said ""go""","{""source"":""test"",""values"":[1,2]}",',
    );
    expect(findArchiveEntry("user-profile.json")).toBeUndefined();
  });

  it("exports raw food-entry provenance instead of the serving aggregate", async () => {
    setupMockDb(Array.from({ length: 17 }, () => []));

    await generateExport(mockDb, "user-1", "/tmp/test.zip", () => {});

    const execute = vi.mocked(mockDb.execute);
    const nutritionDailyQuery = JSON.stringify(
      Reflect.get(execute.mock.calls[5]?.[0] ?? {}, "queryChunks") ?? [],
    );
    const foodEntryQuery = JSON.stringify(
      Reflect.get(execute.mock.calls[6]?.[0] ?? {}, "queryChunks") ?? [],
    );
    expect(nutritionDailyQuery).toContain("fitness.v_nutrition_provider_daily");
    expect(foodEntryQuery).toContain("fitness.food_entry");
    expect(foodEntryQuery).not.toContain("fitness.v_nutrition_daily");
  });

  it("exports canonical menstrual periods, including their notes", async () => {
    const executeResults: Record<string, unknown>[][] = Array.from({ length: 17 }, () => []);
    executeResults[14] = [
      {
        id: "period-1",
        user_id: TEST_USER_ID,
        start_date: "2026-07-03",
        end_date: null,
        notes: "Cramps and poor sleep",
        created_at: "2026-07-03T08:15:00.000Z",
      },
    ];
    setupMockDb(executeResults);

    await generateExport(mockDb, TEST_USER_ID, "/tmp/test.zip", () => {});

    const periodEntry = findArchiveEntry("menstrual-periods.csv");
    expect(periodEntry?.[0]).toBe(
      "id,user_id,start_date,end_date,notes,created_at\nperiod-1,user-1,2026-07-03,,Cramps and poor sleep,2026-07-03T08:15:00.000Z",
    );
    const execute = vi.mocked(mockDb.execute);
    const periodQuery = JSON.stringify(
      Reflect.get(execute.mock.calls[14]?.[0] ?? {}, "queryChunks") ?? [],
    );
    expect(periodQuery).toContain("fitness.menstrual_period");
    expect(periodQuery).toContain("WHERE user_id = ");
    expect(periodQuery).toContain(TEST_USER_ID);
    expect(periodQuery).toContain("ORDER BY start_date");
  });

  it("exports historical breathwork sessions with every returned column", async () => {
    const executeResults: Record<string, unknown>[][] = Array.from({ length: 17 }, () => []);
    executeResults[4] = [
      {
        id: "session-1",
        user_id: "user-1",
        technique_id: "box-breathing",
        rounds: 4,
        duration_seconds: 240,
        started_at: "2026-08-01T07:00:00.000Z",
        notes: "Morning practice",
        stress_before: 7,
        stress_after: 3,
        dizziness_after: false,
        perceived_effect: "better",
        created_at: "2026-08-01T07:04:00.000Z",
      },
      {
        id: "session-2",
        user_id: "user-1",
        technique_id: "coherent-breathing",
        rounds: 5,
        duration_seconds: 300,
        started_at: "2026-08-02T07:00:00.000Z",
        notes: null,
        stress_before: 5,
        stress_after: 2,
        dizziness_after: false,
        perceived_effect: "same",
        created_at: "2026-08-02T07:05:00.000Z",
      },
    ];
    setupMockDb(executeResults);

    await generateExport(mockDb, "user-1", "/tmp/test.zip", () => {});

    const entry = findArchiveEntry("breathwork-sessions.csv");
    expect(entry?.[0]).toBe(
      "id,user_id,technique_id,rounds,duration_seconds,started_at,notes,stress_before,stress_after,dizziness_after,perceived_effect,created_at\nsession-1,user-1,box-breathing,4,240,2026-08-01T07:00:00.000Z,Morning practice,7,3,false,better,2026-08-01T07:04:00.000Z\nsession-2,user-1,coherent-breathing,5,300,2026-08-02T07:00:00.000Z,,5,2,false,same,2026-08-02T07:05:00.000Z",
    );

    const execute = vi.mocked(mockDb.execute);
    const query = JSON.stringify(
      Reflect.get(execute.mock.calls[4]?.[0] ?? {}, "queryChunks") ?? [],
    );
    expect(query).toContain("fitness.breathwork_session");
    expect(query).toContain("WHERE user_id = ");
    expect(query).toContain("user-1");
    expect(query).toContain("ORDER BY started_at");
  });
});
