import { beforeEach, describe, expect, it, vi } from "vitest";

// Create mock functions with the specific signatures we need
const mockReaddirSync = vi.fn<(path: string) => string[]>().mockReturnValue([]);
const mockReadFileSync = vi.fn<(path: string, encoding: string) => string>().mockReturnValue("");
const mockExistsSync = vi.fn<(path: string) => boolean>().mockReturnValue(false);

// Mock node:fs
vi.mock("node:fs", () => ({
  readdirSync: mockReaddirSync,
  readFileSync: mockReadFileSync,
  existsSync: mockExistsSync,
}));

const mockSqlEnd = vi.fn().mockResolvedValue(undefined);
const mockSqlUnsafe = vi.fn().mockResolvedValue([]);

// Tagged template function mock — returns a promise with rows
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

/** Build an ordered log of advisory lock and schema calls from mock.calls */
function buildCallLog(): string[] {
  const log: string[] = [];
  for (const call of mockSql.mock.calls) {
    const first = call[0];
    if (!Array.isArray(first)) continue;
    const raw = first.join("?").trim();
    if (raw.includes("pg_advisory_lock") && !raw.includes("unlock")) log.push("lock");
    if (raw.includes("pg_advisory_unlock")) log.push("unlock");
    if (raw.includes("CREATE SCHEMA")) log.push("schema");
  }
  return log;
}

describe("runMigrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockResolvedValue([]);
    mockSqlUnsafe.mockResolvedValue([]);
    mockSqlEnd.mockResolvedValue(undefined);
  });

  it("creates schemas and migrations table", async () => {
    const { runMigrations } = await import("./migrate.ts");
    mockReaddirSync.mockReturnValue([]);

    await runMigrations("postgres://localhost/test", "/tmp/migrations");

    // Should call sql tagged template 3 times for setup (CREATE SCHEMA x2, CREATE TABLE)
    // plus 1 for SELECT applied migrations
    expect(mockSql).toHaveBeenCalled();
    expect(mockSqlEnd).toHaveBeenCalled();
  });

  it("applies pending migrations and skips already-applied ones", async () => {
    const { runMigrations } = await import("./migrate.ts");

    mockReaddirSync.mockReturnValue(["0001_init.sql", "0002_add_col.sql", "0003_new.sql"]);

    // Already applied: 0001 and 0002
    mockSql.mockImplementation((..._args: unknown[]) => {
      // The 4th call is the SELECT for applied migrations
      return Promise.resolve([{ hash: "0001_init.sql" }, { hash: "0002_add_col.sql" }]);
    });

    mockReadFileSync.mockReturnValue("CREATE TABLE foo (id INT)");

    const count = await runMigrations("postgres://localhost/test", "/tmp/migrations");

    // Only 0003_new.sql should be applied
    expect(count).toBe(1);
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
    expect(mockReadFileSync).toHaveBeenCalledWith("/tmp/migrations/0003_new.sql", "utf-8");
  });

  it("splits migration files on statement breakpoints", async () => {
    const { runMigrations } = await import("./migrate.ts");

    mockReaddirSync.mockReturnValue(["0001_multi.sql"]);
    mockSql.mockResolvedValue([]);
    mockReadFileSync.mockReturnValue(
      "CREATE TABLE a (id INT)--> statement-breakpoint\nCREATE TABLE b (id INT)",
    );

    await runMigrations("postgres://localhost/test", "/tmp/migrations");

    // Should call sql.unsafe twice — once per statement
    expect(mockSqlUnsafe).toHaveBeenCalledTimes(2);
    expect(mockSqlUnsafe).toHaveBeenCalledWith("CREATE TABLE a (id INT)");
    expect(mockSqlUnsafe).toHaveBeenCalledWith("CREATE TABLE b (id INT)");
  });

  it("returns 0 when no pending migrations exist", async () => {
    const { runMigrations } = await import("./migrate.ts");

    mockReaddirSync.mockReturnValue(["0001_init.sql"]);
    mockSql.mockResolvedValue([{ hash: "0001_init.sql" }]);

    const count = await runMigrations("postgres://localhost/test", "/tmp/migrations");

    expect(count).toBe(0);
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it("only considers .sql files", async () => {
    const { runMigrations } = await import("./migrate.ts");

    mockReaddirSync.mockReturnValue(["0001_init.sql", "README.md", "meta.json", "0002_next.sql"]);
    mockSql.mockResolvedValue([]);
    mockReadFileSync.mockReturnValue("SELECT 1");

    const count = await runMigrations("postgres://localhost/test", "/tmp/migrations");

    expect(count).toBe(2);
    expect(mockReadFileSync).toHaveBeenCalledTimes(2);
  });

  it("always closes the connection in finally block", async () => {
    const { runMigrations } = await import("./migrate.ts");

    mockReaddirSync.mockImplementation(() => {
      throw new Error("fs error");
    });

    await expect(runMigrations("postgres://localhost/test", "/tmp/migrations")).rejects.toThrow(
      "fs error",
    );

    expect(mockSqlEnd).toHaveBeenCalled();
  });

  it("acquires advisory lock before schema setup and releases it after", async () => {
    const { runMigrations } = await import("./migrate.ts");
    mockReaddirSync.mockReturnValue([]);

    await runMigrations("postgres://localhost/test", "/tmp/migrations");

    const log = buildCallLog();
    expect(log[0]).toBe("lock");
    expect(log[log.length - 1]).toBe("unlock");
    expect(log.indexOf("lock")).toBeLessThan(log.indexOf("schema"));
  });

  it("releases advisory lock even when migrations fail", async () => {
    const { runMigrations } = await import("./migrate.ts");
    mockReaddirSync.mockImplementation(() => {
      throw new Error("fs error");
    });

    await expect(runMigrations("postgres://localhost/test", "/tmp/migrations")).rejects.toThrow(
      "fs error",
    );

    const log = buildCallLog();
    expect(log).toContain("lock");
    expect(log).toContain("unlock");
  });

  it("rejects duplicate migration prefixes", async () => {
    const { runMigrations } = await import("./migrate.ts");

    mockReaddirSync.mockReturnValue(["0049_add_timezone.sql", "0049_source_external_ids.sql"]);

    await expect(runMigrations("postgres://localhost/test", "/tmp/migrations")).rejects.toThrow(
      "Duplicate migration prefixes",
    );
  });

  it("recreates materialized views from canonical definitions", async () => {
    const { runMigrations } = await import("./migrate.ts");

    // Main dir has no pending migrations
    mockReaddirSync
      .mockReturnValueOnce([]) // migrations dir
      .mockReturnValueOnce(["01_v_activity.sql", "02_activity_summary.sql"]); // views dir

    mockExistsSync.mockReturnValue(true);
    mockSql.mockResolvedValue([]);
    // Each view file contains a CREATE MATERIALIZED VIEW statement
    mockReadFileSync
      .mockReturnValueOnce("CREATE MATERIALIZED VIEW fitness.v_activity AS SELECT 1")
      .mockReturnValueOnce("CREATE MATERIALIZED VIEW fitness.activity_summary AS SELECT 1");

    await runMigrations("postgres://localhost/test", "/tmp/migrations");

    const unsafeCalls = mockSqlUnsafe.mock.calls.map((call) => String(call[0]));
    const dropCalls = unsafeCalls.filter((call) => call.includes("DROP"));
    const createCalls = unsafeCalls.filter((call) => call.includes("CREATE MATERIALIZED"));

    // Drops only managed views in reverse order (dependents first)
    expect(dropCalls).toHaveLength(2);
    expect(dropCalls[0]).toContain("activity_summary");
    expect(dropCalls[1]).toContain("v_activity");

    // Creates in filename order (01_ before 02_)
    expect(createCalls).toHaveLength(2);
  });
});

describe("detectDuplicatePrefixes", () => {
  it("returns empty for unique prefixes", async () => {
    const { detectDuplicatePrefixes } = await import("./migrate.ts");

    const result = detectDuplicatePrefixes(["0001_init.sql", "0002_add_col.sql", "0003_new.sql"]);

    expect(result).toEqual([]);
  });

  it("detects duplicate numeric prefixes", async () => {
    const { detectDuplicatePrefixes } = await import("./migrate.ts");

    const result = detectDuplicatePrefixes([
      "0001_init.sql",
      "0049_add_timezone.sql",
      "0049_source_external_ids.sql",
    ]);

    expect(result).toHaveLength(1);
    const [prefix, group] = result[0] ?? [];
    expect(prefix).toBe("0049");
    expect(group).toEqual(["0049_add_timezone.sql", "0049_source_external_ids.sql"]);
  });

  it("ignores files without numeric prefixes", async () => {
    const { detectDuplicatePrefixes } = await import("./migrate.ts");

    const result = detectDuplicatePrefixes(["README.md", "meta.json"]);

    expect(result).toEqual([]);
  });
});
