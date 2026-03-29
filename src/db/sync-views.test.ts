import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractViewName, hashViewContent } from "./sync-views.ts";

const mockReaddirSync = vi.fn<(path: string) => string[]>().mockReturnValue([]);
const mockReadFileSync = vi.fn<(path: string, encoding: string) => string>().mockReturnValue("");

vi.mock("node:fs", () => ({
  readdirSync: (...args: Parameters<typeof mockReaddirSync>) => mockReaddirSync(...args),
  readFileSync: (...args: Parameters<typeof mockReadFileSync>) => mockReadFileSync(...args),
}));

const mockSqlEnd = vi.fn().mockResolvedValue(undefined);
const mockSqlUnsafe = vi.fn().mockResolvedValue([]);

function createMockSql() {
  return Object.assign(vi.fn().mockResolvedValue([]), {
    unsafe: mockSqlUnsafe,
    end: mockSqlEnd,
  });
}

const mockSql = createMockSql();

vi.mock("postgres", () => ({
  default: vi.fn(() => mockSql),
}));

describe("extractViewName", () => {
  it("extracts simple view name", () => {
    expect(extractViewName("CREATE MATERIALIZED VIEW fitness.v_activity AS SELECT 1")).toBe(
      "fitness.v_activity",
    );
  });

  it("extracts view name with IF NOT EXISTS", () => {
    expect(
      extractViewName(
        "CREATE MATERIALIZED VIEW IF NOT EXISTS fitness.activity_summary AS SELECT 1",
      ),
    ).toBe("fitness.activity_summary");
  });

  it("returns null for non-view SQL", () => {
    expect(extractViewName("CREATE TABLE foo (id INT)")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(extractViewName("create materialized view fitness.v_sleep AS SELECT 1")).toBe(
      "fitness.v_sleep",
    );
  });

  it("handles leading comments", () => {
    const sql = "-- Some comment\nCREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1";
    expect(extractViewName(sql)).toBe("fitness.v_test");
  });
});

describe("hashViewContent", () => {
  it("produces consistent hashes for same content", () => {
    const sql = "CREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1";
    expect(hashViewContent(sql)).toBe(hashViewContent(sql));
  });

  it("ignores leading comment changes", () => {
    const sqlV1 = "-- Version 1\nCREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1";
    const sqlV2 =
      "-- Version 2 with different comment\nCREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1";
    expect(hashViewContent(sqlV1)).toBe(hashViewContent(sqlV2));
  });

  it("produces different hashes for different SQL", () => {
    const sql1 = "CREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1";
    const sql2 = "CREATE MATERIALIZED VIEW fitness.v_test AS SELECT 2";
    expect(hashViewContent(sql1)).not.toBe(hashViewContent(sql2));
  });

  it("preserves statement-breakpoint lines", () => {
    const withBreakpoint =
      "CREATE VIEW x AS SELECT 1\n--> statement-breakpoint\nCREATE INDEX idx ON x (id)";
    const withoutBreakpoint = "CREATE VIEW x AS SELECT 1\nCREATE INDEX idx ON x (id)";
    expect(hashViewContent(withBreakpoint)).not.toBe(hashViewContent(withoutBreakpoint));
  });
});

describe("syncMaterializedViews", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockResolvedValue([]);
    mockSqlUnsafe.mockResolvedValue([]);
    mockSqlEnd.mockResolvedValue(undefined);
  });

  it("returns zeros when no view files exist", async () => {
    const { syncMaterializedViews } = await import("./sync-views.ts");
    mockReaddirSync.mockReturnValue([]);

    const result = await syncMaterializedViews("postgres://localhost/test", "/tmp/views");

    expect(result).toEqual({ synced: 0, skipped: 0 });
  });

  it("skips views whose hash matches the stored hash", async () => {
    const { syncMaterializedViews, hashViewContent: hash } = await import("./sync-views.ts");
    const viewSql = "CREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1";
    const expectedHash = hash(viewSql);

    mockReaddirSync.mockReturnValue(["01_v_test.sql"]);
    mockReadFileSync.mockReturnValue(viewSql);
    // First call: CREATE TABLE (tracking table) — returns []
    // Second call: SELECT hash — returns matching hash
    mockSql.mockResolvedValueOnce([]); // CREATE TABLE
    mockSql.mockResolvedValueOnce([{ hash: expectedHash }]); // SELECT hash

    const result = await syncMaterializedViews("postgres://localhost/test", "/tmp/views");

    expect(result).toEqual({ synced: 0, skipped: 1 });
    // Should NOT call sql.unsafe (no DROP/CREATE)
    expect(mockSqlUnsafe).not.toHaveBeenCalled();
  });

  it("recreates views whose hash has changed", async () => {
    const { syncMaterializedViews } = await import("./sync-views.ts");
    const viewSql = "CREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1";

    mockReaddirSync.mockReturnValue(["01_v_test.sql"]);
    mockReadFileSync.mockReturnValue(viewSql);
    mockSql.mockResolvedValueOnce([]); // CREATE TABLE
    mockSql.mockResolvedValueOnce([{ hash: "old-hash-that-does-not-match" }]); // SELECT hash

    const result = await syncMaterializedViews("postgres://localhost/test", "/tmp/views");

    expect(result).toEqual({ synced: 1, skipped: 0 });
    // Should call sql.unsafe for DROP and CREATE
    expect(mockSqlUnsafe).toHaveBeenCalledWith(
      "DROP MATERIALIZED VIEW IF EXISTS fitness.v_test CASCADE",
    );
    expect(mockSqlUnsafe).toHaveBeenCalledWith(viewSql);
  });

  it("creates new views that have no stored hash", async () => {
    const { syncMaterializedViews } = await import("./sync-views.ts");
    const viewSql = "CREATE MATERIALIZED VIEW fitness.v_new AS SELECT 1";

    mockReaddirSync.mockReturnValue(["01_v_new.sql"]);
    mockReadFileSync.mockReturnValue(viewSql);
    mockSql.mockResolvedValueOnce([]); // CREATE TABLE
    mockSql.mockResolvedValueOnce([]); // SELECT hash — no rows

    const result = await syncMaterializedViews("postgres://localhost/test", "/tmp/views");

    expect(result).toEqual({ synced: 1, skipped: 0 });
    expect(mockSqlUnsafe).toHaveBeenCalledWith(
      "DROP MATERIALIZED VIEW IF EXISTS fitness.v_new CASCADE",
    );
  });

  it("processes files in sorted order", async () => {
    const { syncMaterializedViews } = await import("./sync-views.ts");

    mockReaddirSync.mockReturnValue(["02_b.sql", "01_a.sql"]);
    mockReadFileSync
      .mockReturnValueOnce("CREATE MATERIALIZED VIEW fitness.a AS SELECT 1")
      .mockReturnValueOnce("CREATE MATERIALIZED VIEW fitness.b AS SELECT 2");
    // All return empty (no stored hashes)
    mockSql.mockResolvedValue([]);

    await syncMaterializedViews("postgres://localhost/test", "/tmp/views");

    // Verify files read in sorted order
    const readCalls = mockReadFileSync.mock.calls.map((call) => call[0]);
    expect(readCalls[0]).toContain("01_a.sql");
    expect(readCalls[1]).toContain("02_b.sql");
  });

  it("splits on statement-breakpoint and executes each statement", async () => {
    const { syncMaterializedViews } = await import("./sync-views.ts");
    const viewSql =
      "CREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1\n--> statement-breakpoint\nCREATE UNIQUE INDEX idx ON fitness.v_test (id)";

    mockReaddirSync.mockReturnValue(["01_v_test.sql"]);
    mockReadFileSync.mockReturnValue(viewSql);
    mockSql.mockResolvedValue([]);

    await syncMaterializedViews("postgres://localhost/test", "/tmp/views");

    // DROP + 2 statements (CREATE VIEW + CREATE INDEX)
    expect(mockSqlUnsafe).toHaveBeenCalledTimes(3);
    expect(mockSqlUnsafe).toHaveBeenCalledWith(
      "DROP MATERIALIZED VIEW IF EXISTS fitness.v_test CASCADE",
    );
    expect(mockSqlUnsafe).toHaveBeenCalledWith(
      "CREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1",
    );
    expect(mockSqlUnsafe).toHaveBeenCalledWith("CREATE UNIQUE INDEX idx ON fitness.v_test (id)");
  });

  it("always closes the connection in finally block", async () => {
    const { syncMaterializedViews } = await import("./sync-views.ts");
    mockReaddirSync.mockImplementation(() => {
      throw new Error("fs error");
    });

    // When there are no files, it returns early before creating a connection
    // So test with files that cause an error after connection is created
    mockReaddirSync.mockReturnValue(["01_test.sql"]);
    mockReadFileSync.mockReturnValue("CREATE MATERIALIZED VIEW fitness.v_test AS SELECT 1");
    mockSql.mockRejectedValueOnce(new Error("db error"));

    await expect(syncMaterializedViews("postgres://localhost/test", "/tmp/views")).rejects.toThrow(
      "db error",
    );

    expect(mockSqlEnd).toHaveBeenCalled();
  });
});
