import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createDatabaseFromEnv } from "./index.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setupTestDatabase();
}, 120_000);

afterAll(async () => {
  await ctx?.cleanup();
});

describe("createDatabase", () => {
  it("returns a valid Drizzle instance that can execute queries", async () => {
    const db = createDatabase(ctx.connectionString);
    try {
      const rows = await db.execute<{ one: number }>(sql`SELECT 1 AS one`);
      expect(rows.length).toBe(1);
      expect(rows[0]?.one).toBe(1);
    } finally {
      await db.$client.end();
    }
  });

  it("has schema tables available", async () => {
    const db = createDatabase(ctx.connectionString);
    try {
      const tables = await db.execute<{ table_name: string }>(
        sql`SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'fitness'
            ORDER BY table_name`,
      );

      const tableNames = tables.map((t) => t.table_name);
      expect(tableNames).toContain("provider");
      expect(tableNames).toContain("activity");
      expect(tableNames).toContain("sync_log");
    } finally {
      await db.$client.end();
    }
  });
});

describe("createDatabaseFromEnv", () => {
  it("throws when DATABASE_URL is not set", () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => createDatabaseFromEnv()).toThrow(
        "DATABASE_URL environment variable is required",
      );
    } finally {
      if (original !== undefined) {
        process.env.DATABASE_URL = original;
      }
    }
  });

  it("returns a database when DATABASE_URL is set", async () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = ctx.connectionString;
    try {
      const db = createDatabaseFromEnv();
      try {
        expect(db).toBeDefined();
        const rows = await db.execute<{ one: number }>(sql`SELECT 1 AS one`);
        expect(rows[0]?.one).toBe(1);
      } finally {
        await db.$client.end();
      }
    } finally {
      if (original !== undefined) {
        process.env.DATABASE_URL = original;
      } else {
        delete process.env.DATABASE_URL;
      }
    }
  });
});
