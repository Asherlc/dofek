import { afterEach, describe, expect, it, vi } from "vitest";

const pgState = vi.hoisted<{
  connections: string[];
  endedConnections: string[];
  queryFailures: Array<{ error: Error; remainingFailures: number; sqlIncludes: string }>;
  queries: Array<{ connectionString: string; sql: string }>;
}>(() => ({
  connections: [],
  endedConnections: [],
  queryFailures: [],
  queries: [],
}));

const createDatabaseState = vi.hoisted<{
  endedConnections: string[];
}>(() => ({
  endedConnections: [],
}));

vi.mock("pg", () => {
  class MockClient {
    readonly connectionString: string;

    constructor(config: { connectionString: string }) {
      this.connectionString = config.connectionString;
    }

    async connect(): Promise<void> {
      pgState.connections.push(this.connectionString);
    }

    async query(statement: string): Promise<{ rows: [] }> {
      pgState.queries.push({ connectionString: this.connectionString, sql: statement });
      const matchingFailure = pgState.queryFailures.find(
        (failure) => failure.remainingFailures > 0 && statement.includes(failure.sqlIncludes),
      );
      if (matchingFailure) {
        matchingFailure.remainingFailures -= 1;
        throw matchingFailure.error;
      }
      return { rows: [] };
    }

    async end(): Promise<void> {
      pgState.endedConnections.push(this.connectionString);
    }
  }

  return {
    Client: MockClient,
    escapeIdentifier: (identifier: string) => `"${identifier.replaceAll('"', '""')}"`,
  };
});

vi.mock("testcontainers", () => ({
  GenericContainer: class {
    withEnvironment(): this {
      return this;
    }

    withExposedPorts(): this {
      return this;
    }

    async start(): Promise<never> {
      throw new Error("TEST_DATABASE_URL should use the shared Postgres path");
    }
  },
}));

const originalBeforeExitListeners = process.listeners("beforeExit");

const removeAddedBeforeExitListeners = (): void => {
  for (const listener of process.listeners("beforeExit")) {
    if (!originalBeforeExitListeners.includes(listener)) {
      process.off("beforeExit", listener);
    }
  }
};

const waitForAsyncCleanup = async (): Promise<void> => {
  await new Promise((resolveWait) => setTimeout(resolveWait, 0));
};

vi.mock("./index.ts", () => ({
  createDatabase: (connectionString: string) => ({
    $client: {
      end: async () => {
        createDatabaseState.endedConnections.push(connectionString);
      },
    },
  }),
}));

describe("setupTestDatabase", () => {
  const originalTestDatabaseUrl = process.env.TEST_DATABASE_URL;

  afterEach(() => {
    removeAddedBeforeExitListeners();
    if (originalTestDatabaseUrl === undefined) {
      delete process.env.TEST_DATABASE_URL;
    } else {
      process.env.TEST_DATABASE_URL = originalTestDatabaseUrl;
    }
    pgState.connections.length = 0;
    pgState.endedConnections.length = 0;
    pgState.queryFailures.length = 0;
    pgState.queries.length = 0;
    createDatabaseState.endedConnections.length = 0;
    vi.resetModules();
  });

  it("fails before opening a database connection when TEST_DATABASE_URL is missing", async () => {
    delete process.env.TEST_DATABASE_URL;

    const { setupTestDatabase } = await import("./test-helpers.ts");

    await expect(setupTestDatabase()).rejects.toThrow(
      "TEST_DATABASE_URL is required for integration tests. Run `pnpm test:integration` to start the workspace database.",
    );
    expect(pgState.connections).toEqual([]);
  });

  it("creates one migrated template database and clones test databases from it", async () => {
    process.env.TEST_DATABASE_URL = "postgres://test:test@localhost:5432/test";

    const { setupTestDatabase } = await import("./test-helpers.ts");

    const firstContext = await setupTestDatabase();
    const secondContext = await setupTestDatabase();
    await firstContext.cleanup();
    await secondContext.cleanup();

    const createDatabaseStatements = pgState.queries
      .map(({ sql }) => sql)
      .filter((sql) => sql.startsWith("CREATE DATABASE"));
    const templateCreateStatements = createDatabaseStatements.filter((sql) =>
      sql.startsWith('CREATE DATABASE "dofek_integration_template_'),
    );
    const clonedDatabaseStatements = createDatabaseStatements.filter(
      (sql) => sql.startsWith('CREATE DATABASE "test_') && sql.includes(" WITH TEMPLATE "),
    );
    const templateConnectionStrings = pgState.connections.filter((connectionString) =>
      connectionString.includes("/dofek_integration_template_"),
    );
    const dropDatabaseStatements = pgState.queries
      .map(({ sql }) => sql)
      .filter((sql) => sql.startsWith('DROP DATABASE IF EXISTS "test_'));
    const templateConnectionLockStatements = pgState.queries
      .map(({ sql }) => sql)
      .filter((sql) => sql.startsWith('ALTER DATABASE "dofek_integration_template_'));
    const templateBackendTerminationStatements = pgState.queries
      .map(({ sql }) => sql)
      .filter((sql) => sql.includes("pg_terminate_backend"));

    expect(templateCreateStatements).toHaveLength(1);
    expect(clonedDatabaseStatements).toHaveLength(2);
    expect(templateConnectionStrings.length).toBeGreaterThan(0);
    expect(dropDatabaseStatements).toHaveLength(2);
    expect(templateConnectionLockStatements).toHaveLength(1);
    expect(templateBackendTerminationStatements.length).toBeGreaterThanOrEqual(2);
  });

  it("uses distinct template databases for isolated module instances in one process", async () => {
    process.env.TEST_DATABASE_URL = "postgres://test:test@localhost:5432/test";

    const firstModule = await import("./test-helpers.ts");
    const firstContext = await firstModule.setupTestDatabase();
    await firstContext.cleanup();

    vi.resetModules();
    const secondModule = await import("./test-helpers.ts");
    const secondContext = await secondModule.setupTestDatabase();
    await secondContext.cleanup();

    const templateCreateStatements = pgState.queries
      .map(({ sql }) => sql)
      .filter((sql) => sql.startsWith('CREATE DATABASE "dofek_integration_template_'));

    expect(new Set(templateCreateStatements).size).toBe(2);
  });

  it("retries template creation after a transient failure", async () => {
    process.env.TEST_DATABASE_URL = "postgres://test:test@localhost:5432/test";
    pgState.queryFailures.push({
      error: new Error("temporary create failure"),
      remainingFailures: 1,
      sqlIncludes: 'CREATE DATABASE "dofek_integration_template_',
    });

    const { setupTestDatabase } = await import("./test-helpers.ts");

    await expect(setupTestDatabase()).rejects.toThrow("temporary create failure");
    const context = await setupTestDatabase();
    await context.cleanup();

    const templateCreateStatements = pgState.queries
      .map(({ sql }) => sql)
      .filter((sql) => sql.startsWith('CREATE DATABASE "dofek_integration_template_'));

    expect(templateCreateStatements).toHaveLength(2);
  });

  it("closes the admin connection when clone creation fails", async () => {
    process.env.TEST_DATABASE_URL = "postgres://test:test@localhost:5432/test";
    pgState.queryFailures.push({
      error: new Error("temporary clone failure"),
      remainingFailures: 1,
      sqlIncludes: " WITH TEMPLATE ",
    });

    const { setupTestDatabase } = await import("./test-helpers.ts");

    await expect(setupTestDatabase()).rejects.toThrow("temporary clone failure");

    const adminConnections = pgState.connections.filter(
      (connectionString) => connectionString === process.env.TEST_DATABASE_URL,
    );
    const endedAdminConnections = pgState.endedConnections.filter(
      (connectionString) => connectionString === process.env.TEST_DATABASE_URL,
    );

    expect(endedAdminConnections).toHaveLength(adminConnections.length);
  });

  it("drops the process template database at process teardown", async () => {
    process.env.TEST_DATABASE_URL = "postgres://test:test@localhost:5432/test";
    const listenersBeforeSetup = process.listeners("beforeExit");

    const { setupTestDatabase } = await import("./test-helpers.ts");

    const context = await setupTestDatabase();
    await context.cleanup();

    const cleanupListener = process
      .listeners("beforeExit")
      .find((listener) => !listenersBeforeSetup.includes(listener));
    if (!cleanupListener) {
      throw new Error("Template cleanup listener was not registered");
    }
    process.off("beforeExit", cleanupListener);

    const templateDropsBeforeCleanup = pgState.queries.filter(({ sql }) =>
      sql.startsWith('DROP DATABASE IF EXISTS "dofek_integration_template_'),
    ).length;
    const cleanupResult = Reflect.apply(cleanupListener, process, []);
    if (cleanupResult instanceof Promise) {
      await cleanupResult;
    }
    await waitForAsyncCleanup();
    const templateDropsAfterCleanup = pgState.queries.filter(({ sql }) =>
      sql.startsWith('DROP DATABASE IF EXISTS "dofek_integration_template_'),
    ).length;

    expect(templateDropsAfterCleanup).toBe(templateDropsBeforeCleanup + 1);
  });
});
