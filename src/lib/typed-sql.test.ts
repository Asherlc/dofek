import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executeWithSchema } from "./typed-sql.ts";

describe("executeWithSchema", () => {
  const rowSchema = z.object({
    id: z.string(),
    value: z.coerce.number(),
  });

  function createMockDb(rows: Record<string, unknown>[]) {
    return { execute: vi.fn().mockResolvedValue(rows) };
  }

  it("returns parsed rows matching the schema", async () => {
    const db = createMockDb([
      { id: "a", value: "42" },
      { id: "b", value: 7 },
    ]);

    const result = await executeWithSchema(db, rowSchema, sql`SELECT 1`);

    expect(result).toEqual([
      { id: "a", value: 42 },
      { id: "b", value: 7 },
    ]);
  });

  it("returns empty array for empty result set", async () => {
    const db = createMockDb([]);
    const result = await executeWithSchema(db, rowSchema, sql`SELECT 1`);
    expect(result).toEqual([]);
  });

  it("throws on schema mismatch", async () => {
    const db = createMockDb([{ wrong_field: "oops" }]);
    await expect(executeWithSchema(db, rowSchema, sql`SELECT 1`)).rejects.toThrow();
  });

  it("passes the query to db.execute", async () => {
    const db = createMockDb([]);
    const query = sql`SELECT * FROM foo`;
    await executeWithSchema(db, rowSchema, query);
    expect(db.execute).toHaveBeenCalledWith(query);
  });
});
