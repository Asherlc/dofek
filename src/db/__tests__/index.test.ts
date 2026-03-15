import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDrizzleReturn = { query: {} };
const mockDrizzle = vi.fn(() => mockDrizzleReturn);
const mockPostgresReturn = { end: vi.fn() };
const mockPostgres = vi.fn(() => mockPostgresReturn);

vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: mockDrizzle,
}));

vi.mock("postgres", () => ({
  default: mockPostgres,
}));

describe("db/index", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DATABASE_URL;
  });

  describe("createDatabase", () => {
    it("creates a postgres client with the given connection string", async () => {
      const { createDatabase } = await import("../index.ts");
      createDatabase("postgres://localhost:5432/test");

      expect(mockPostgres).toHaveBeenCalledWith("postgres://localhost:5432/test", {
        max: 5,
        idle_timeout: 30,
        connect_timeout: 10,
      });
    });

    it("creates a drizzle instance with the postgres client and schema", async () => {
      const { createDatabase } = await import("../index.ts");
      const schema = await import("../schema.ts");
      createDatabase("postgres://localhost:5432/test");

      expect(mockDrizzle).toHaveBeenCalledWith(mockPostgresReturn, { schema });
    });

    it("returns the drizzle instance", async () => {
      const { createDatabase } = await import("../index.ts");
      const db = createDatabase("postgres://localhost:5432/test");

      expect(db).toBe(mockDrizzleReturn);
    });
  });

  describe("createDatabaseFromEnv", () => {
    it("throws when DATABASE_URL is not set", async () => {
      const { createDatabaseFromEnv } = await import("../index.ts");
      expect(() => createDatabaseFromEnv()).toThrow("DATABASE_URL environment variable is required");
    });

    it("creates a database using DATABASE_URL from env", async () => {
      process.env.DATABASE_URL = "postgres://envhost:5432/envdb";
      const { createDatabaseFromEnv } = await import("../index.ts");
      const db = createDatabaseFromEnv();

      expect(mockPostgres).toHaveBeenCalledWith(
        "postgres://envhost:5432/envdb",
        expect.objectContaining({ max: 5 }),
      );
      expect(db).toBe(mockDrizzleReturn);
    });
  });
});
