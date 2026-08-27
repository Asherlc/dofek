import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCaptureException = vi.fn();
const mockLoggerError = vi.fn();
const mockDrizzleReturn = {
  query: {},
  execute: vi.fn(),
  transaction: vi.fn(),
  $client: { end: vi.fn() },
};
const mockDrizzle = vi.fn(() => mockDrizzleReturn);
const mockPoolInstance = {
  on: vi.fn(),
  totalCount: 0,
  idleCount: 0,
  waitingCount: 0,
};
const mockPool = vi.fn(
  class {
    constructor() {
      return mockPoolInstance;
    }
  },
);
const mockRegisterPostgresPoolMetrics = vi.fn();

vi.mock("@sentry/node", () => ({
  captureException: mockCaptureException,
}));

vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: mockDrizzle,
}));

vi.mock("../logger.ts", () => ({
  logger: {
    error: mockLoggerError,
  },
}));

vi.mock("./pool-metrics.ts", () => ({
  registerPostgresPoolMetrics: mockRegisterPostgresPoolMetrics,
}));

vi.mock("pg", () => ({
  Pool: mockPool,
}));

describe("db/index", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDrizzleReturn.execute = vi.fn();
    mockDrizzleReturn.transaction = vi.fn();
    mockDrizzleReturn.$client = { end: vi.fn() };
    delete process.env.DATABASE_URL;
  });

  describe("createDatabase", () => {
    it("creates a pool with the given connection string", async () => {
      const { createDatabase } = await import("./index.ts");
      createDatabase("postgres://localhost:5432/test");

      expect(mockPool).toHaveBeenCalledWith({
        connectionString: "postgres://localhost:5432/test",
        max: 10,
        idleTimeoutMillis: 300_000,
        connectionTimeoutMillis: 10_000,
        maxLifetimeSeconds: 600,
        keepAlive: true,
        keepAliveInitialDelayMillis: 60_000,
      });
    });

    it("creates a drizzle instance with the pool and schema", async () => {
      const { createDatabase } = await import("./index.ts");
      const { drizzleSchema } = await import("./drizzle-schema.ts");
      createDatabase("postgres://localhost:5432/test");

      expect(mockDrizzle).toHaveBeenCalledWith(mockPoolInstance, { schema: drizzleSchema });
    });

    it("registers observable pool state metrics", async () => {
      const { createDatabase } = await import("./index.ts");

      createDatabase("postgres://localhost:5432/test");

      expect(mockRegisterPostgresPoolMetrics).toHaveBeenCalledWith(mockPoolInstance);
    });

    it("reports idle pool client errors", async () => {
      const { createDatabase } = await import("./index.ts");
      const error = new Error("Connection terminated unexpectedly");

      createDatabase("postgres://localhost:5432/test");
      const errorHandler = mockPoolInstance.on.mock.calls.find(
        ([eventName]) => eventName === "error",
      )?.[1];
      expect(errorHandler).toBeTypeOf("function");

      errorHandler?.(error);

      expect(mockLoggerError).toHaveBeenCalledWith(
        "[db] PostgreSQL pool idle client error: Connection terminated unexpectedly",
      );
      expect(mockCaptureException).toHaveBeenCalledWith(error, {
        tags: { source: "postgres-pool" },
      });
    });

    it("preserves the existing row-array execute contract", async () => {
      const { createDatabase } = await import("./index.ts");
      mockDrizzleReturn.execute.mockResolvedValueOnce({ rows: [{ id: 1 }] });

      const db = createDatabase("postgres://localhost:5432/test");
      const rows = await db.execute<{ id: number }>("SELECT 1 AS id");

      expect(rows).toEqual([{ id: 1 }]);
    });
  });

  describe("createDatabaseFromEnv", () => {
    it("throws when DATABASE_URL is not set", async () => {
      const { createDatabaseFromEnv } = await import("./index.ts");
      expect(() => createDatabaseFromEnv()).toThrow(
        "DATABASE_URL environment variable is required",
      );
    });

    it("creates a database using DATABASE_URL from env", async () => {
      process.env.DATABASE_URL = "postgres://envhost:5432/envdb";
      const { createDatabaseFromEnv } = await import("./index.ts");
      const db = createDatabaseFromEnv();

      expect(mockPool).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionString: "postgres://envhost:5432/envdb",
          max: 10,
        }),
      );
      expect(db).toBe(mockDrizzleReturn);
    });
  });
});
