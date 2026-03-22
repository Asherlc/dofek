import { beforeEach, describe, expect, it, vi } from "vitest";

// Create mock functions with the specific signatures we need
const mockReaddirSync = vi.fn<(path: string) => string[]>().mockReturnValue([]);
const mockReadFileSync = vi.fn<(path: string, encoding: string) => string>().mockReturnValue("");

// Mock node:fs
vi.mock("node:fs", () => ({
  readdirSync: mockReaddirSync,
  readFileSync: mockReadFileSync,
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
});
