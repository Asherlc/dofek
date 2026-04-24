import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDrizzleReturn = {
  query: {},
  execute: vi.fn(),
  $client: { end: vi.fn() },
};
const mockDrizzle = vi.fn(() => mockDrizzleReturn);
const mockPoolInstance = {};
const mockPool = vi.fn(() => mockPoolInstance);

vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: mockDrizzle,
}));

vi.mock("pg", () => ({
  Pool: mockPool,
}));

describe("db/index", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDrizzleReturn.execute = vi.fn();
    mockDrizzleReturn.$client = { end: vi.fn() };
    delete process.env.DATABASE_URL;
  });

  describe("createDatabase", () => {
    it("creates a pool with the given connection string", async () => {
      const { createDatabase } = await import("./index.ts");
      createDatabase("postgres://localhost:5432/test");

      expect(mockPool).toHaveBeenCalledWith({
        connectionString: "postgres://localhost:5432/test",
        max: 5,
        idleTimeoutMillis: 300_000,
        connectionTimeoutMillis: 10_000,
        maxLifetimeSeconds: 600,
        keepAlive: true,
        keepAliveInitialDelayMillis: 60_000,
      });
    });

    it("creates a drizzle instance with the pool and schema", async () => {
      const { createDatabase } = await import("./index.ts");
      const schema = await import("./schema.ts");
      createDatabase("postgres://localhost:5432/test");

      expect(mockDrizzle).toHaveBeenCalledWith(mockPoolInstance, { schema });
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
          max: 5,
        }),
      );
      expect(db).toBe(mockDrizzleReturn);
    });
  });
});
