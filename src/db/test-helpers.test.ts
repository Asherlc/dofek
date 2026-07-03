import { afterEach, describe, expect, it, vi } from "vitest";

const pgState = vi.hoisted<{
  connections: string[];
  endedConnections: string[];
  queries: Array<{ connectionString: string; sql: string }>;
}>(() => ({
  connections: [],
  endedConnections: [],
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
    if (originalTestDatabaseUrl === undefined) {
      delete process.env.TEST_DATABASE_URL;
    } else {
      process.env.TEST_DATABASE_URL = originalTestDatabaseUrl;
    }
    pgState.connections.length = 0;
    pgState.endedConnections.length = 0;
    pgState.queries.length = 0;
    createDatabaseState.endedConnections.length = 0;
    vi.resetModules();
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
      .filter((sql) => sql.startsWith('DROP DATABASE "test_'));
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
});
