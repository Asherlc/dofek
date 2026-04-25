import { beforeEach, describe, expect, it, vi } from "vitest";

const mockReaddirSync = vi.fn<(path: string) => string[]>().mockReturnValue([]);
const mockReadFileSync = vi.fn<(path: string, encoding: string) => string>().mockReturnValue("");
const mockExistsSync = vi.fn<(path: string) => boolean>().mockReturnValue(false);

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

const { mockClientConnect, mockClientEnd, mockClientQuery, mockClientConstructor } = vi.hoisted(
  () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const end = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const clientInstance = {
      connect,
      end,
      query,
    };
    return {
      mockClientConnect: connect,
      mockClientEnd: end,
      mockClientQuery: query,
      mockClientConstructor: vi.fn(() => clientInstance),
    };
  },
);

vi.mock("pg", () => ({
  Client: mockClientConstructor,
}));

function buildCallLog(): string[] {
  return mockClientQuery.mock.calls.flatMap(([text]) => {
    const sql = String(text);
    const events: string[] = [];
    if (sql.includes("pg_advisory_lock") && !sql.includes("unlock")) events.push("lock");
    if (sql.includes("pg_advisory_unlock")) events.push("unlock");
    if (sql.includes("CREATE SCHEMA")) events.push("schema");
    return events;
  });
}

function executedQueries(): string[] {
  return mockClientQuery.mock.calls.map(([text]) => String(text));
}

describe("runMigrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClientConnect.mockResolvedValue(undefined);
    mockClientEnd.mockResolvedValue(undefined);
    mockClientQuery.mockResolvedValue({ rows: [] });
  });

  it("creates schemas and migrations table", async () => {
    const { runMigrations } = await import("./migrate.ts");
    mockReaddirSync.mockReturnValue([]);

    await runMigrations("postgres://localhost/test", "/tmp/migrations");

    expect(mockClientConnect).toHaveBeenCalled();
    expect(executedQueries()).toContain("CREATE SCHEMA IF NOT EXISTS health");
    expect(executedQueries()).toContain("CREATE SCHEMA IF NOT EXISTS drizzle");
    expect(
      executedQueries().some((query) =>
        query.includes("CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations"),
      ),
    ).toBe(true);
    expect(mockClientEnd).toHaveBeenCalled();
  });

  it("applies pending migrations and skips already-applied ones", async () => {
    const { runMigrations } = await import("./migrate.ts");

    mockReaddirSync.mockReturnValue(["0001_init.sql", "0002_add_col.sql", "0003_new.sql"]);
    mockReadFileSync.mockReturnValue("CREATE TABLE foo (id INT)");
    mockClientQuery.mockImplementation((text: string) => {
      if (text === "SELECT hash, content_hash FROM drizzle.__drizzle_migrations") {
        return Promise.resolve({
          rows: [{ hash: "0001_init.sql" }, { hash: "0002_add_col.sql" }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const count = await runMigrations("postgres://localhost/test", "/tmp/migrations");

    expect(count).toBe(1);
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
    expect(mockReadFileSync).toHaveBeenCalledWith("/tmp/migrations/0003_new.sql", "utf-8");
    expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining("Applying: 0003_new.sql"));
    expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining("Applied 1 migration"));
  });

  it("splits migration files on statement breakpoints", async () => {
    const { runMigrations } = await import("./migrate.ts");

    mockReaddirSync.mockReturnValue(["0001_multi.sql"]);
    mockReadFileSync.mockReturnValue(
      "CREATE TABLE a (id INT)--> statement-breakpoint\nCREATE TABLE b (id INT)",
    );

    await runMigrations("postgres://localhost/test", "/tmp/migrations");

    expect(executedQueries()).toContain("CREATE TABLE a (id INT)");
    expect(executedQueries()).toContain("CREATE TABLE b (id INT)");
  });

  it("returns 0 when no pending migrations exist", async () => {
    const { runMigrations } = await import("./migrate.ts");

    mockReaddirSync.mockReturnValue(["0001_init.sql"]);
    mockClientQuery.mockImplementation((text: string) => {
      if (text === "SELECT hash, content_hash FROM drizzle.__drizzle_migrations") {
        return Promise.resolve({ rows: [{ hash: "0001_init.sql" }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const count = await runMigrations("postgres://localhost/test", "/tmp/migrations");

    expect(count).toBe(0);
    expect(mockReadFileSync).not.toHaveBeenCalled();
    const infoMessages = mockLoggerInfo.mock.calls.map((call) => String(call[0]));
    expect(infoMessages.every((message) => !message.includes("Applied"))).toBe(true);
  });

  it("only considers .sql files", async () => {
    const { runMigrations } = await import("./migrate.ts");

    mockReaddirSync.mockReturnValue(["0001_init.sql", "README.md", "meta.json", "0002_next.sql"]);
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

    expect(mockClientEnd).toHaveBeenCalled();
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

    mockClientQuery.mockImplementation((text: string) => {
      if (text.includes("pg_advisory_unlock")) {
        return Promise.reject(new Error("connection lost"));
      }
      return Promise.resolve({ rows: [] });
    });

    await runMigrations("postgres://localhost/test", "/tmp/migrations");

    expect(mockLoggerWarn).toHaveBeenCalledWith("Advisory unlock failed: %s", expect.any(Error));
  });

  it("stores content hash when applying a migration", async () => {
    const { runMigrations } = await import("./migrate.ts");

    mockReaddirSync.mockReturnValue(["0001_init.sql"]);
    mockReadFileSync.mockReturnValue("CREATE TABLE foo (id INT)");

    await runMigrations("postgres://localhost/test", "/tmp/migrations");

    const insertCalls = mockClientQuery.mock.calls.filter(([text]) =>
      String(text).includes("INSERT INTO drizzle.__drizzle_migrations"),
    );
    expect(insertCalls.length).toBeGreaterThan(0);
    const hashArg = insertCalls[0]?.[1]?.[2];
    expect(hashArg).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stores whether an applied migration requires materialized view refresh", async () => {
    const { runMigrations } = await import("./migrate.ts");

    mockReaddirSync.mockReturnValue(["0001_refresh_views.sql"]);
    mockReadFileSync.mockReturnValue(
      "-- requires_materialized_view_refresh\nALTER TABLE fitness.activity ADD COLUMN source TEXT",
    );

    await runMigrations("postgres://localhost/test", "/tmp/migrations");

    const insertCall = mockClientQuery.mock.calls.find(([text]) =>
      String(text).includes("INSERT INTO drizzle.__drizzle_migrations"),
    );
    expect(insertCall?.[1]?.[3]).toBe(true);
  });

  it("warns when an applied migration file has been modified", async () => {
    const { runMigrations } = await import("./migrate.ts");

    mockReaddirSync.mockReturnValue(["0001_init.sql"]);
    mockReadFileSync.mockReturnValue("CREATE TABLE foo (id INT) -- modified");
    mockExistsSync.mockReturnValue(true);
    mockClientQuery.mockImplementation((text: string) => {
      if (text === "SELECT hash, content_hash FROM drizzle.__drizzle_migrations") {
        return Promise.resolve({
          rows: [
            {
              hash: "0001_init.sql",
              content_hash: "0000000000000000000000000000000000000000000000000000000000000000",
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    await runMigrations("postgres://localhost/test", "/tmp/migrations");

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("0001_init.sql has been modified"),
    );
  });

  it("skips content hash check for migrations without stored hash", async () => {
    const { runMigrations } = await import("./migrate.ts");

    mockReaddirSync.mockReturnValue(["0001_init.sql"]);
    mockReadFileSync.mockReturnValue("CREATE TABLE foo (id INT)");
    mockClientQuery.mockImplementation((text: string) => {
      if (text === "SELECT hash, content_hash FROM drizzle.__drizzle_migrations") {
        return Promise.resolve({ rows: [{ hash: "0001_init.sql", content_hash: null }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await runMigrations("postgres://localhost/test", "/tmp/migrations");

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
    mockClientQuery.mockImplementation((text: string) => {
      if (text === "SELECT hash, content_hash FROM drizzle.__drizzle_migrations") {
        return Promise.resolve({ rows: [{ hash: "0001_init.sql", content_hash: expectedHash }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await runMigrations("postgres://localhost/test", "/tmp/migrations");

    const warnMessages = mockLoggerWarn.mock.calls.map((call) => String(call[0]));
    expect(warnMessages.every((message) => !message.includes("modified"))).toBe(true);
  });

  it("warns on duplicate migration prefixes instead of throwing", async () => {
    const { runMigrations } = await import("./migrate.ts");

    mockReaddirSync.mockReturnValue(["0049_add_timezone.sql", "0049_source_external_ids.sql"]);
    mockReadFileSync.mockReturnValue("SELECT 1");

    await runMigrations("postgres://localhost/test", "/tmp/migrations");

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("Duplicate migration prefixes"),
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("0049"));
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("0049_add_timezone.sql"));
  });

  it("does not recreate materialized views (handled by syncMaterializedViews)", async () => {
    const { runMigrations } = await import("./migrate.ts");

    mockReaddirSync.mockReturnValue([]);
    mockExistsSync.mockReturnValue(true);

    await runMigrations("postgres://localhost/test", "/tmp/migrations");

    const queries = executedQueries();
    expect(queries.some((query) => query.includes("DROP MATERIALIZED"))).toBe(false);
    expect(queries.some((query) => query.includes("CREATE MATERIALIZED"))).toBe(false);
  });

  it("applies baseline migrations on fresh databases", async () => {
    const { runMigrations } = await import("./migrate.ts");

    mockReaddirSync.mockReturnValue(["0000_baseline.sql", "0001_additional.sql"]);
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.endsWith("0000_baseline.sql")) return "CREATE TABLE baseline_table (id INT)";
      if (path.endsWith("0001_additional.sql")) return "CREATE TABLE additional_table (id INT)";
      return "";
    });

    const count = await runMigrations("postgres://localhost/test", "/tmp/migrations");

    expect(count).toBe(2);
    expect(executedQueries()).toContain("CREATE TABLE baseline_table (id INT)");
    expect(executedQueries()).toContain("CREATE TABLE additional_table (id INT)");
  });

  it("skips baseline when migration tracking is empty but schema has tables", async () => {
    const { runMigrations } = await import("./migrate.ts");

    mockReaddirSync.mockReturnValue(["0000_baseline.sql", "0001_additional.sql"]);
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.endsWith("0000_baseline.sql")) return "CREATE TABLE baseline_table (id INT)";
      if (path.endsWith("0001_additional.sql")) return "CREATE TABLE additional_table (id INT)";
      return "";
    });
    mockClientQuery.mockImplementation((text: string) => {
      if (text.includes("information_schema.tables")) {
        return Promise.resolve({ rows: [{ has_tables: true }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const count = await runMigrations("postgres://localhost/test", "/tmp/migrations");

    expect(count).toBe(1);
    expect(executedQueries()).not.toContain("CREATE TABLE baseline_table (id INT)");
    expect(executedQueries()).toContain("CREATE TABLE additional_table (id INT)");
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("Marking baseline migration as applied"),
    );
  });

  it("marks baseline migrations as applied on existing databases", async () => {
    const { runMigrations } = await import("./migrate.ts");

    mockReaddirSync.mockReturnValue(["0000_baseline.sql", "0001_additional.sql"]);
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.endsWith("0000_baseline.sql")) return "CREATE TABLE baseline_table (id INT)";
      if (path.endsWith("0001_additional.sql")) return "CREATE TABLE additional_table (id INT)";
      return "";
    });
    mockClientQuery.mockImplementation((text: string) => {
      if (text === "SELECT hash, content_hash FROM drizzle.__drizzle_migrations") {
        return Promise.resolve({ rows: [{ hash: "0059_previous.sql", content_hash: null }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const count = await runMigrations("postgres://localhost/test", "/tmp/migrations");

    expect(count).toBe(1);
    expect(executedQueries()).not.toContain("CREATE TABLE baseline_table (id INT)");
    expect(executedQueries()).toContain("CREATE TABLE additional_table (id INT)");
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
