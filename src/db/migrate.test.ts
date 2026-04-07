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

const mockLoggerWarn = vi.fn();
const mockLoggerInfo = vi.fn();

vi.mock("../logger.ts", () => ({
  logger: {
    warn: mockLoggerWarn,
    info: mockLoggerInfo,
  },
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

    expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining("Applying: 0003_new.sql"));
    expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining("Applied 1 migration"));
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
    // Should NOT log "Applied" when nothing was applied
    const infoMessages = mockLoggerInfo.mock.calls.map((call) => String(call[0]));
    expect(infoMessages.every((message) => !message.includes("Applied"))).toBe(true);
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

  it("warns when advisory unlock fails", async () => {
    const { runMigrations } = await import("./migrate.ts");
    mockReaddirSync.mockReturnValue([]);

    // Make the advisory unlock call reject
    mockSql.mockImplementation((...args: unknown[]) => {
      const first = args[0];
      if (Array.isArray(first) && first.join("").includes("pg_advisory_unlock")) {
        return Promise.reject(new Error("connection lost"));
      }
      return Promise.resolve([]);
    });

    await runMigrations("postgres://localhost/test", "/tmp/migrations");

    expect(mockLoggerWarn).toHaveBeenCalledWith("Advisory unlock failed: %s", expect.any(Error));
  });

  it("stores content hash when applying a migration", async () => {
    const { runMigrations } = await import("./migrate.ts");

    mockReaddirSync.mockReturnValue(["0001_init.sql"]);
    mockSql.mockResolvedValue([]);
    mockReadFileSync.mockReturnValue("CREATE TABLE foo (id INT)");

    await runMigrations("postgres://localhost/test", "/tmp/migrations");

    // The INSERT should include a content_hash parameter
    const insertCalls = mockSql.mock.calls.filter(
      (call) => Array.isArray(call[0]) && call[0].join("").includes("INSERT"),
    );
    expect(insertCalls.length).toBeGreaterThan(0);
    // Tagged template: sql`...VALUES (${file}, ${dateNow}, ${contentHash})`
    // call[0] = template strings, call[1] = file, call[2] = Date.now(), call[3] = contentHash
    const hashArg = insertCalls[0]?.[3];
    expect(hashArg).toMatch(/^[0-9a-f]{64}$/);
  });

  it("warns when an applied migration file has been modified", async () => {
    const { runMigrations } = await import("./migrate.ts");

    mockReaddirSync.mockReturnValue(["0001_init.sql"]);
    mockReadFileSync.mockReturnValue("CREATE TABLE foo (id INT) -- modified");
    mockExistsSync.mockReturnValue(true);

    // Return applied migration with a DIFFERENT content hash
    mockSql.mockResolvedValue([
      {
        hash: "0001_init.sql",
        content_hash: "0000000000000000000000000000000000000000000000000000000000000000",
      },
    ]);

    await runMigrations("postgres://localhost/test", "/tmp/migrations");

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("0001_init.sql has been modified"),
    );
  });

  it("skips content hash check for migrations without stored hash", async () => {
    const { runMigrations } = await import("./migrate.ts");

    mockReaddirSync.mockReturnValue(["0001_init.sql"]);
    mockReadFileSync.mockReturnValue("CREATE TABLE foo (id INT)");

    // Applied migration without content_hash (legacy row)
    mockSql.mockResolvedValue([{ hash: "0001_init.sql", content_hash: null }]);

    await runMigrations("postgres://localhost/test", "/tmp/migrations");

    // Should NOT warn about modification
    const warnMessages = mockLoggerWarn.mock.calls.map((call) => String(call[0]));
    expect(warnMessages.every((message) => !message.includes("modified"))).toBe(true);
  });

  it("does not warn when content hash matches", async () => {
    const { runMigrations, computeContentHash } = await import("./migrate.ts");

    const content = "CREATE TABLE foo (id INT)";
    mockReaddirSync.mockReturnValue(["0001_init.sql"]);
    mockReadFileSync.mockReturnValue(content);
    mockExistsSync.mockReturnValue(true);

    const expectedHash = computeContentHash(content);
    mockSql.mockResolvedValue([{ hash: "0001_init.sql", content_hash: expectedHash }]);

    await runMigrations("postgres://localhost/test", "/tmp/migrations");

    const warnMessages = mockLoggerWarn.mock.calls.map((call) => String(call[0]));
    expect(warnMessages.every((message) => !message.includes("modified"))).toBe(true);
  });

  it("warns on duplicate migration prefixes instead of throwing", async () => {
    const { runMigrations } = await import("./migrate.ts");

    mockReaddirSync.mockReturnValue(["0049_add_timezone.sql", "0049_source_external_ids.sql"]);
    mockReadFileSync.mockReturnValue("SELECT 1");
    mockSql.mockResolvedValue([]);

    // Should not throw — just log a warning
    await runMigrations("postgres://localhost/test", "/tmp/migrations");

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("Duplicate migration prefixes"),
    );
    // Verify details include the actual prefix and filenames
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("0049"));
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("0049_add_timezone.sql"));
  });

  it("does not recreate materialized views (handled by syncMaterializedViews)", async () => {
    const { runMigrations } = await import("./migrate.ts");

    mockReaddirSync.mockReturnValue([]);
    mockExistsSync.mockReturnValue(true);
    mockSql.mockResolvedValue([]);

    await runMigrations("postgres://localhost/test", "/tmp/migrations");

    const unsafeCalls = mockSqlUnsafe.mock.calls.map((call) => String(call[0]));
    const dropCalls = unsafeCalls.filter((call) => call.includes("DROP MATERIALIZED"));
    const createCalls = unsafeCalls.filter((call) => call.includes("CREATE MATERIALIZED"));

    // runMigrations should NOT touch materialized views
    expect(dropCalls).toHaveLength(0);
    expect(createCalls).toHaveLength(0);
  });

  it("applies baseline migrations on fresh databases", async () => {
    const { runMigrations } = await import("./migrate.ts");

    mockReaddirSync.mockReturnValue(["0000_baseline.sql", "0001_additional.sql"]);
    mockSql.mockResolvedValue([]);
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.endsWith("0000_baseline.sql")) return "CREATE TABLE baseline_table (id INT)";
      if (path.endsWith("0001_additional.sql")) return "CREATE TABLE additional_table (id INT)";
      return "";
    });

    const count = await runMigrations("postgres://localhost/test", "/tmp/migrations");

    expect(count).toBe(2);
    expect(mockSqlUnsafe).toHaveBeenCalledWith("CREATE TABLE baseline_table (id INT)");
    expect(mockSqlUnsafe).toHaveBeenCalledWith("CREATE TABLE additional_table (id INT)");
  });

  it("marks baseline migrations as applied on existing databases", async () => {
    const { runMigrations } = await import("./migrate.ts");

    mockReaddirSync.mockReturnValue(["0000_baseline.sql", "0001_additional.sql"]);
    mockSql.mockResolvedValue([{ hash: "0059_previous.sql", content_hash: null }]);
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.endsWith("0000_baseline.sql")) return "CREATE TABLE baseline_table (id INT)";
      if (path.endsWith("0001_additional.sql")) return "CREATE TABLE additional_table (id INT)";
      return "";
    });

    const count = await runMigrations("postgres://localhost/test", "/tmp/migrations");

    expect(count).toBe(1);
    const unsafeStatements = mockSqlUnsafe.mock.calls.map((call) => String(call[0]));
    expect(unsafeStatements).not.toContain("CREATE TABLE baseline_table (id INT)");
    expect(unsafeStatements).toContain("CREATE TABLE additional_table (id INT)");
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("Marking baseline migration as applied"),
    );
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
