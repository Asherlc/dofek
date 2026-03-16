import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executeWithSchema } from "./typed-sql.ts";

const mockExecute = vi.fn();

function createMockDb() {
  return { execute: mockExecute };
}

describe("executeWithSchema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns parsed rows when data matches schema", async () => {
    const schema = z.object({
      id: z.number(),
      name: z.string(),
    });

    mockExecute.mockResolvedValue([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);

    const mockDb = createMockDb();
    const query = sql`SELECT * FROM users`;

    const result = await executeWithSchema(mockDb, schema, query);

    expect(result).toEqual([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);
    expect(mockExecute).toHaveBeenCalledWith(query);
  });

  it("returns empty array when query returns no rows", async () => {
    const schema = z.object({ id: z.number() });
    mockExecute.mockResolvedValue([]);

    const mockDb = createMockDb();
    const result = await executeWithSchema(mockDb, schema, sql`SELECT 1`);

    expect(result).toEqual([]);
  });

  it("throws ZodError when a row does not match the schema", async () => {
    const schema = z.object({
      id: z.number(),
      name: z.string(),
    });

    mockExecute.mockResolvedValue([{ id: "not-a-number", name: "Alice" }]);

    const mockDb = createMockDb();

    await expect(executeWithSchema(mockDb, schema, sql`SELECT * FROM users`)).rejects.toThrow(
      z.ZodError,
    );
  });

  it("throws when row has missing fields", async () => {
    const schema = z.object({
      id: z.number(),
      name: z.string(),
    });

    mockExecute.mockResolvedValue([{ id: 1 }]); // missing 'name'

    const mockDb = createMockDb();

    await expect(executeWithSchema(mockDb, schema, sql`SELECT id FROM users`)).rejects.toThrow(
      z.ZodError,
    );
  });

  it("coerces values when schema uses coerce", async () => {
    const schema = z.object({
      count: z.coerce.number(),
    });

    mockExecute.mockResolvedValue([{ count: "42" }]);

    const mockDb = createMockDb();
    const result = await executeWithSchema(mockDb, schema, sql`SELECT count(*)`);

    expect(result).toEqual([{ count: 42 }]);
  });

  it("strips extra fields when schema uses strict or passthrough appropriately", async () => {
    const schema = z.object({
      id: z.number(),
    });

    // Row has extra fields that aren't in schema — z.object strips them by default
    mockExecute.mockResolvedValue([{ id: 1, extra: "field" }]);

    const mockDb = createMockDb();
    const result = await executeWithSchema(mockDb, schema, sql`SELECT *`);

    expect(result).toEqual([{ id: 1 }]);
  });
});
