import { beforeEach, describe, expect, it, vi } from "vitest";

const migratorMocks = vi.hoisted(() => ({
  readBaselineMigration: vi.fn().mockReturnValue({
    folderMillis: 1_773_118_304_010,
    hash: "baseline-content-hash",
  }),
  runDrizzleMigrations: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./postgres-migrator.ts", () => migratorMocks);

const accountErasureCoverageMocks = vi.hoisted(() => ({
  assert: vi.fn().mockResolvedValue(undefined),
  database: { execute: vi.fn().mockResolvedValue([{ installed: false }]) },
  refresh: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: vi.fn(() => accountErasureCoverageMocks.database),
}));

vi.mock("../account-erasure/postgres-erasure.ts", () => ({
  assertPostgresAccountErasureCoverage: accountErasureCoverageMocks.assert,
  refreshPostgresAccountErasureWriteFences: accountErasureCoverageMocks.refresh,
}));

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../logger.ts", () => ({ logger: loggerMocks }));

const postgresMocks = vi.hoisted(() => {
  const connect = vi.fn().mockResolvedValue(undefined);
  const end = vi.fn().mockResolvedValue(undefined);
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const client = { connect, end, query };
  return {
    client,
    connect,
    constructor: vi.fn(
      class {
        constructor() {
          return client;
        }
      },
    ),
    end,
    query,
  };
});

vi.mock("pg", () => ({ Client: postgresMocks.constructor }));

function queryTextCalls(): string[] {
  return postgresMocks.query.mock.calls.map(([query]) => String(query));
}

function mockDatabaseState(options?: {
  migrationCounts?: number[];
  schemaHasTables?: boolean;
}): void {
  const migrationCounts = [...(options?.migrationCounts ?? [0, 0, 0])];
  postgresMocks.query.mockImplementation((query: string) => {
    if (query === "SELECT count(*) AS count FROM drizzle.__drizzle_migrations") {
      return Promise.resolve({ rows: [{ count: String(migrationCounts.shift() ?? 0) }] });
    }
    if (query.includes("information_schema.tables")) {
      return Promise.resolve({ rows: [{ has_tables: options?.schemaHasTables ?? false }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe("runMigrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postgresMocks.connect.mockResolvedValue(undefined);
    postgresMocks.end.mockResolvedValue(undefined);
    migratorMocks.runDrizzleMigrations.mockResolvedValue(undefined);
    migratorMocks.readBaselineMigration.mockReturnValue({
      folderMillis: 1_773_118_304_010,
      hash: "baseline-content-hash",
    });
    accountErasureCoverageMocks.database.execute.mockResolvedValue([{ installed: false }]);
    mockDatabaseState();
  });

  it("marks the baseline before Drizzle migrates an existing untracked schema", async () => {
    const { runMigrations } = await import("./migrate.ts");
    mockDatabaseState({ migrationCounts: [0, 1, 3], schemaHasTables: true });

    const count = await runMigrations("postgres://localhost/test", "/tmp/migrations");

    expect(count).toBe(2);
    expect(migratorMocks.readBaselineMigration).toHaveBeenCalledWith("/tmp/migrations");
    expect(postgresMocks.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO drizzle.__drizzle_migrations"),
      ["baseline-content-hash", 1_773_118_304_010],
    );
    expect(loggerMocks.info).toHaveBeenCalledWith(
      expect.stringContaining("Marking baseline migration as applied"),
    );
  });

  it("runs Drizzle migrations and returns the number applied", async () => {
    const { runMigrations } = await import("./migrate.ts");
    mockDatabaseState({ migrationCounts: [0, 0, 2] });

    const count = await runMigrations("postgres://localhost/test", "/tmp/migrations");

    expect(count).toBe(2);
    expect(migratorMocks.runDrizzleMigrations).toHaveBeenCalledWith(
      postgresMocks.client,
      "/tmp/migrations",
    );
    expect(migratorMocks.readBaselineMigration).not.toHaveBeenCalled();
  });

  it("treats an empty migration count result as no applied migrations", async () => {
    const { runMigrations } = await import("./migrate.ts");
    let migrationCountQueryIndex = 0;
    postgresMocks.query.mockImplementation((query: string) => {
      if (query === "SELECT count(*) AS count FROM drizzle.__drizzle_migrations") {
        migrationCountQueryIndex += 1;
        return Promise.resolve({
          rows: migrationCountQueryIndex === 1 ? [] : [{ count: "0" }],
        });
      }
      if (query.includes("information_schema.tables")) {
        return Promise.resolve({ rows: [{ has_tables: false }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(runMigrations("postgres://localhost/test", "/tmp/migrations")).resolves.toBe(0);
    expect(migratorMocks.readBaselineMigration).not.toHaveBeenCalled();
  });

  it("treats an empty schema inspection result as no existing tables", async () => {
    const { runMigrations } = await import("./migrate.ts");
    postgresMocks.query.mockImplementation((query: string) => {
      if (query === "SELECT count(*) AS count FROM drizzle.__drizzle_migrations") {
        return Promise.resolve({ rows: [{ count: "0" }] });
      }
      if (query.includes("information_schema.tables")) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(runMigrations("postgres://localhost/test", "/tmp/migrations")).resolves.toBe(0);
    expect(migratorMocks.readBaselineMigration).not.toHaveBeenCalled();
  });

  it("does not mark a baseline when migration history already exists", async () => {
    const { runMigrations } = await import("./migrate.ts");
    mockDatabaseState({ migrationCounts: [1, 1, 1], schemaHasTables: true });

    await expect(runMigrations("postgres://localhost/test", "/tmp/migrations")).resolves.toBe(0);
    expect(migratorMocks.readBaselineMigration).not.toHaveBeenCalled();
  });

  it("holds the advisory lock while Drizzle migrates", async () => {
    const { runMigrations } = await import("./migrate.ts");

    await runMigrations("postgres://localhost/test", "/tmp/migrations");

    const lockCall = postgresMocks.query.mock.calls.findIndex(
      ([query]) => String(query) === "SELECT pg_advisory_lock($1)",
    );
    const unlockCall = postgresMocks.query.mock.calls.findIndex(([query]) =>
      String(query).includes("pg_advisory_unlock"),
    );
    const migrationCallOrder = migratorMocks.runDrizzleMigrations.mock.invocationCallOrder[0];
    const lockCallOrder = postgresMocks.query.mock.invocationCallOrder[lockCall];
    const unlockCallOrder = postgresMocks.query.mock.invocationCallOrder[unlockCall];

    expect(lockCallOrder).toBeLessThan(migrationCallOrder ?? 0);
    expect(migrationCallOrder).toBeLessThan(unlockCallOrder ?? 0);
  });

  it("refreshes and asserts account-erasure coverage after migrations while holding the lock", async () => {
    const { runMigrations } = await import("./migrate.ts");
    mockDatabaseState();
    postgresMocks.query.mockImplementation((query: string) => {
      if (query === "SELECT count(*) AS count FROM drizzle.__drizzle_migrations") {
        return Promise.resolve({ rows: [{ count: "0" }] });
      }
      if (query.includes("information_schema.tables")) {
        return Promise.resolve({ rows: [{ has_tables: false }] });
      }
      if (query.includes("to_regprocedure")) {
        return Promise.resolve({ rows: [{ installed: true }] });
      }
      return Promise.resolve({ rows: [] });
    });
    accountErasureCoverageMocks.database.execute.mockResolvedValue([{ installed: true }]);

    await runMigrations("postgres://localhost/test", "/tmp/migrations");

    expect(accountErasureCoverageMocks.refresh).toHaveBeenCalledWith(
      accountErasureCoverageMocks.database,
    );
    expect(accountErasureCoverageMocks.assert).toHaveBeenCalledWith(
      accountErasureCoverageMocks.database,
    );
    const migrationCallOrder = migratorMocks.runDrizzleMigrations.mock.invocationCallOrder[0];
    const refreshCallOrder = accountErasureCoverageMocks.refresh.mock.invocationCallOrder[0];
    const assertCallOrder = accountErasureCoverageMocks.assert.mock.invocationCallOrder[0];
    const unlockCall = postgresMocks.query.mock.calls.findIndex(([query]) =>
      String(query).includes("pg_advisory_unlock"),
    );
    const unlockCallOrder = postgresMocks.query.mock.invocationCallOrder[unlockCall];
    expect(migrationCallOrder).toBeLessThan(refreshCallOrder ?? 0);
    expect(refreshCallOrder).toBeLessThan(assertCallOrder ?? 0);
    expect(assertCallOrder).toBeLessThan(unlockCallOrder ?? 0);
  });

  it("skips the account-erasure coverage hook before its migration is installed", async () => {
    const { runMigrations } = await import("./migrate.ts");

    await runMigrations("postgres://localhost/test", "/tmp/migrations");

    expect(accountErasureCoverageMocks.refresh).not.toHaveBeenCalled();
    expect(accountErasureCoverageMocks.assert).not.toHaveBeenCalled();
  });

  it("runs a custom migration folder without a baseline against an existing schema", async () => {
    const { runMigrations } = await import("./migrate.ts");
    mockDatabaseState({ migrationCounts: [0, 0, 1], schemaHasTables: true });
    migratorMocks.readBaselineMigration.mockReturnValue(undefined);

    const count = await runMigrations("postgres://localhost/test", "/tmp/migrations");

    expect(count).toBe(1);
    expect(migratorMocks.runDrizzleMigrations).toHaveBeenCalledOnce();
    expect(
      queryTextCalls().some((query) => query.includes("INSERT INTO drizzle.__drizzle_migrations")),
    ).toBe(false);
  });

  it("fails when the canonical folder has no baseline for an existing untracked schema", async () => {
    const { runMigrations } = await import("./migrate.ts");
    mockDatabaseState({ migrationCounts: [0], schemaHasTables: true });
    migratorMocks.readBaselineMigration.mockReturnValue(undefined);

    await expect(runMigrations("postgres://localhost/test")).rejects.toThrow(
      "Postgres baseline migration is required",
    );

    expect(queryTextCalls()).toContain("SELECT pg_advisory_unlock($1)");
    expect(postgresMocks.end).toHaveBeenCalledOnce();
  });

  it("releases the advisory lock when Drizzle migration fails", async () => {
    const { runMigrations } = await import("./migrate.ts");
    migratorMocks.runDrizzleMigrations.mockRejectedValue(new Error("migration failed"));

    await expect(runMigrations("postgres://localhost/test", "/tmp/migrations")).rejects.toThrow(
      "migration failed",
    );

    const migrationCallOrder = migratorMocks.runDrizzleMigrations.mock.invocationCallOrder[0];
    const unlockCall = postgresMocks.query.mock.calls.findIndex(([query]) =>
      String(query).includes("pg_advisory_unlock"),
    );
    const unlockCallOrder = postgresMocks.query.mock.invocationCallOrder[unlockCall];
    expect(migrationCallOrder).toBeLessThan(unlockCallOrder ?? 0);
    expect(postgresMocks.end).toHaveBeenCalledOnce();
  });

  it("warns when advisory unlock fails", async () => {
    const { runMigrations } = await import("./migrate.ts");
    mockDatabaseState();
    postgresMocks.query.mockImplementation((query: string) => {
      if (query === "SELECT count(*) AS count FROM drizzle.__drizzle_migrations") {
        return Promise.resolve({ rows: [{ count: "0" }] });
      }
      if (query.includes("information_schema.tables")) {
        return Promise.resolve({ rows: [{ has_tables: false }] });
      }
      if (query.includes("pg_advisory_unlock")) {
        return Promise.reject(new Error("connection lost"));
      }
      return Promise.resolve({ rows: [] });
    });

    await runMigrations("postgres://localhost/test", "/tmp/migrations");

    expect(loggerMocks.warn).toHaveBeenCalledWith("Advisory unlock failed: %s", expect.any(Error));
  });
});
