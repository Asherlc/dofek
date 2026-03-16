import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:fs
vi.mock("node:fs", () => ({
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
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

const mockedReaddirSync = vi.mocked(readdirSync);
const mockedReadFileSync = vi.mocked(readFileSync);

describe("runMigrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockResolvedValue([]);
    mockSqlUnsafe.mockResolvedValue([]);
    mockSqlEnd.mockResolvedValue(undefined);
  });

  it("creates schemas and migrations table", async () => {
    const { runMigrations } = await import("../migrate.ts");
    mockedReaddirSync.mockReturnValue([]);

    await runMigrations("postgres://localhost/test", "/tmp/migrations");

    // Should call sql tagged template 3 times for setup (CREATE SCHEMA x2, CREATE TABLE)
    // plus 1 for SELECT applied migrations
    expect(mockSql).toHaveBeenCalled();
    expect(mockSqlEnd).toHaveBeenCalled();
  });

  it("applies pending migrations and skips already-applied ones", async () => {
    const { runMigrations } = await import("../migrate.ts");

    // @ts-expect-error string[] not assignable to Dirent[]
    mockedReaddirSync.mockReturnValue(["0001_init.sql", "0002_add_col.sql", "0003_new.sql"]);

    // Already applied: 0001 and 0002
    mockSql.mockImplementation((..._args: unknown[]) => {
      // The 4th call is the SELECT for applied migrations
      return Promise.resolve([{ hash: "0001_init.sql" }, { hash: "0002_add_col.sql" }]);
    });

    mockedReadFileSync.mockReturnValue("CREATE TABLE foo (id INT)");

    const count = await runMigrations("postgres://localhost/test", "/tmp/migrations");

    // Only 0003_new.sql should be applied
    expect(count).toBe(1);
    expect(mockedReadFileSync).toHaveBeenCalledTimes(1);
    expect(mockedReadFileSync).toHaveBeenCalledWith("/tmp/migrations/0003_new.sql", "utf-8");
  });

  it("splits migration files on statement breakpoints", async () => {
    const { runMigrations } = await import("../migrate.ts");

    // @ts-expect-error string[] not assignable to Dirent[]
    mockedReaddirSync.mockReturnValue(["0001_multi.sql"]);
    mockSql.mockResolvedValue([]);
    mockedReadFileSync.mockReturnValue(
      "CREATE TABLE a (id INT)--> statement-breakpoint\nCREATE TABLE b (id INT)",
    );

    await runMigrations("postgres://localhost/test", "/tmp/migrations");

    // Should call sql.unsafe twice — once per statement
    expect(mockSqlUnsafe).toHaveBeenCalledTimes(2);
    expect(mockSqlUnsafe).toHaveBeenCalledWith("CREATE TABLE a (id INT)");
    expect(mockSqlUnsafe).toHaveBeenCalledWith("CREATE TABLE b (id INT)");
  });

  it("returns 0 when no pending migrations exist", async () => {
    const { runMigrations } = await import("../migrate.ts");

    // @ts-expect-error string[] not assignable to Dirent[]
    mockedReaddirSync.mockReturnValue(["0001_init.sql"]);
    mockSql.mockResolvedValue([{ hash: "0001_init.sql" }]);

    const count = await runMigrations("postgres://localhost/test", "/tmp/migrations");

    expect(count).toBe(0);
    expect(mockedReadFileSync).not.toHaveBeenCalled();
  });

  it("only considers .sql files", async () => {
    const { runMigrations } = await import("../migrate.ts");

    // @ts-expect-error string[] not assignable to Dirent[]
    mockedReaddirSync.mockReturnValue(["0001_init.sql", "README.md", "meta.json", "0002_next.sql"]);
    mockSql.mockResolvedValue([]);
    mockedReadFileSync.mockReturnValue("SELECT 1");

    const count = await runMigrations("postgres://localhost/test", "/tmp/migrations");

    expect(count).toBe(2);
    expect(mockedReadFileSync).toHaveBeenCalledTimes(2);
  });

  it("always closes the connection in finally block", async () => {
    const { runMigrations } = await import("../migrate.ts");

    mockedReaddirSync.mockImplementation(() => {
      throw new Error("fs error");
    });

    await expect(runMigrations("postgres://localhost/test", "/tmp/migrations")).rejects.toThrow(
      "fs error",
    );

    expect(mockSqlEnd).toHaveBeenCalled();
  });
});
