import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executeWithSchema } from "../../lib/typed-sql.ts";

describe("executeWithSchema", () => {
  it("executes query and parses rows with schema", async () => {
    const schema = z.object({
      id: z.number(),
      name: z.string(),
    });
    const mockDb = {
      execute: vi.fn().mockResolvedValue([
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ]),
    };

    const result = await executeWithSchema(mockDb as never, schema, sql`SELECT * FROM test`);

    expect(result).toEqual([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);
    expect(mockDb.execute).toHaveBeenCalledOnce();
  });

  it("returns empty array when query returns no rows", async () => {
    const schema = z.object({ id: z.number() });
    const mockDb = {
      execute: vi.fn().mockResolvedValue([]),
    };

    const result = await executeWithSchema(mockDb as never, schema, sql`SELECT * FROM empty_table`);

    expect(result).toEqual([]);
  });

  it("coerces numeric strings using z.coerce", async () => {
    const schema = z.object({
      value: z.coerce.number(),
    });
    const mockDb = {
      execute: vi.fn().mockResolvedValue([{ value: "42.5" }]),
    };

    const result = await executeWithSchema(mockDb as never, schema, sql`SELECT value FROM test`);

    expect(result).toEqual([{ value: 42.5 }]);
  });

  it("throws ZodError when row does not match schema", async () => {
    const schema = z.object({
      id: z.number(),
      name: z.string(),
    });
    const mockDb = {
      execute: vi.fn().mockResolvedValue([{ id: "not-a-number", name: 123 }]),
    };

    await expect(
      executeWithSchema(mockDb as never, schema, sql`SELECT * FROM test`),
    ).rejects.toThrow();
  });

  it("handles nullable fields", async () => {
    const schema = z.object({
      id: z.number(),
      value: z.coerce.number().nullable(),
    });
    const mockDb = {
      execute: vi.fn().mockResolvedValue([
        { id: 1, value: null },
        { id: 2, value: "10" },
      ]),
    };

    const result = await executeWithSchema(mockDb as never, schema, sql`SELECT * FROM test`);

    expect(result).toEqual([
      { id: 1, value: null },
      { id: 2, value: 10 },
    ]);
  });
});
