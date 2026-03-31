import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BaseRepository } from "./base-repository.ts";

// Concrete subclass for testing
class TestRepository extends BaseRepository {
  async runQuery(schema: z.ZodType, sqlQuery: ReturnType<typeof sql>) {
    return this.query(schema, sqlQuery);
  }

  // Expose protected fields for assertions
  get exposedDb() {
    return this.db;
  }
  get exposedUserId() {
    return this.userId;
  }
  get exposedTimezone() {
    return this.timezone;
  }
}

describe("BaseRepository", () => {
  const mockDb = { execute: vi.fn() };

  it("stores db, userId, and timezone", () => {
    const repo = new TestRepository(mockDb, "user-1", "America/New_York");
    expect(repo.exposedDb).toBe(mockDb);
    expect(repo.exposedUserId).toBe("user-1");
    expect(repo.exposedTimezone).toBe("America/New_York");
  });

  it("defaults timezone to UTC when omitted", () => {
    const repo = new TestRepository(mockDb, "user-1");
    expect(repo.exposedTimezone).toBe("UTC");
  });

  it("query() delegates to executeWithSchema and parses rows", async () => {
    const schema = z.object({ value: z.number() });
    mockDb.execute.mockResolvedValueOnce([{ value: 42 }]);

    const repo = new TestRepository(mockDb, "user-1");
    const rows = await repo.runQuery(schema, sql`SELECT 42 AS value`);

    expect(rows).toEqual([{ value: 42 }]);
    expect(mockDb.execute).toHaveBeenCalledOnce();
  });

  it("query() throws on schema mismatch", async () => {
    const schema = z.object({ value: z.number() });
    mockDb.execute.mockResolvedValueOnce([{ value: "not-a-number" }]);

    const repo = new TestRepository(mockDb, "user-1");
    await expect(repo.runQuery(schema, sql`SELECT 'bad'`)).rejects.toThrow();
  });
});
