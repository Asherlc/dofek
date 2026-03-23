import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Database } from "./typed-sql.ts";
import { dateStringSchema, executeWithSchema, timestampStringSchema } from "./typed-sql.ts";

function createMockDb(rows: Record<string, unknown>[] = []): Database {
  return {
    execute: vi.fn().mockResolvedValue(rows),
  };
}

// --- executeWithSchema ---

describe("executeWithSchema", () => {
  const rowSchema = z.object({
    id: z.number(),
    name: z.string(),
  });

  it("parses rows with the provided Zod schema", async () => {
    const db = createMockDb([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);

    const result = await executeWithSchema(db, rowSchema, sql`SELECT 1`);

    expect(result).toEqual([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);
  });

  it("returns an empty array when query returns no rows", async () => {
    const db = createMockDb([]);
    const result = await executeWithSchema(db, rowSchema, sql`SELECT 1`);
    expect(result).toEqual([]);
  });

  it("throws when a row does not match the schema", async () => {
    const db = createMockDb([{ id: "not-a-number", name: "Alice" }]);

    await expect(executeWithSchema(db, rowSchema, sql`SELECT 1`)).rejects.toThrow();
  });

  it("passes the SQL query to db.execute", async () => {
    const db = createMockDb([]);
    const query = sql`SELECT * FROM users`;
    await executeWithSchema(db, rowSchema, query);

    expect(db.execute).toHaveBeenCalledWith(query);
  });

  it("applies Zod transforms", async () => {
    const transformSchema = z.object({
      value: z.coerce.number(),
    });
    const db = createMockDb([{ value: "42" }]);

    const result = await executeWithSchema(db, transformSchema, sql`SELECT 1`);
    expect(result).toEqual([{ value: 42 }]);
  });

  it("throws on the first invalid row (fail-fast)", async () => {
    const db = createMockDb([
      { id: 1, name: "Valid" },
      { id: "invalid", name: 123 },
    ]);

    // The .map() will throw on the second row
    await expect(executeWithSchema(db, rowSchema, sql`SELECT 1`)).rejects.toThrow();
  });
});

// --- dateStringSchema ---

describe("dateStringSchema", () => {
  it("passes through a YYYY-MM-DD string as-is", () => {
    expect(dateStringSchema.parse("2026-03-20")).toBe("2026-03-20");
  });

  it("converts a Date object to YYYY-MM-DD string", () => {
    const date = new Date("2026-03-20T15:30:00.000Z");
    expect(dateStringSchema.parse(date)).toBe("2026-03-20");
  });

  it("rejects non-string, non-date values", () => {
    expect(() => dateStringSchema.parse(12345)).toThrow();
    expect(() => dateStringSchema.parse(null)).toThrow();
    expect(() => dateStringSchema.parse(undefined)).toThrow();
  });
});

// --- timestampStringSchema ---

describe("timestampStringSchema", () => {
  it("converts a Date object to ISO 8601 string", () => {
    const date = new Date("2026-03-20T15:30:00.000Z");
    expect(timestampStringSchema.parse(date)).toBe("2026-03-20T15:30:00.000Z");
  });

  it("normalizes a postgres-style timestamp string to ISO 8601", () => {
    const pgTimestamp = "2026-03-20 19:40:29.678162+00";
    const result = timestampStringSchema.parse(pgTimestamp);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(result).toContain("T");
  });

  it("passes through an already valid ISO 8601 string (after re-parse)", () => {
    const iso = "2026-03-20T15:30:00.000Z";
    expect(timestampStringSchema.parse(iso)).toBe(iso);
  });

  it("returns the original string if Date parsing fails", () => {
    const unparseable = "not-a-date";
    expect(timestampStringSchema.parse(unparseable)).toBe("not-a-date");
  });

  it("rejects non-string, non-date values", () => {
    expect(() => timestampStringSchema.parse(12345)).toThrow();
    expect(() => timestampStringSchema.parse(null)).toThrow();
  });
});

// --- Database interface ---

describe("Database interface", () => {
  it("is structurally compatible with a simple mock", () => {
    const db: Database = {
      execute: vi.fn().mockResolvedValue([]),
    };
    // TypeScript compilation is the test — if this compiles, the interface is correct
    expect(db.execute).toBeDefined();
  });
});
