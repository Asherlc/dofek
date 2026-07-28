import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executeWithSchema } from "./execute-with-schema.ts";

const mockExecute = vi.fn();

function createMockDb() {
  return { execute: mockExecute };
}

describe("executeWithSchema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns parsed array rows", async () => {
    const schema = z.object({ id: z.number(), name: z.string() });
    mockExecute.mockResolvedValue([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);
    const query = sql`SELECT * FROM users`;

    await expect(executeWithSchema(createMockDb(), schema, query)).resolves.toEqual([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);
    expect(mockExecute).toHaveBeenCalledWith(query);
  });

  it("returns parsed transaction result rows", async () => {
    mockExecute.mockResolvedValue({ rows: [{ id: 1 }] });

    await expect(
      executeWithSchema(createMockDb(), z.object({ id: z.number() }), sql`SELECT 1`),
    ).resolves.toEqual([{ id: 1 }]);
  });

  it.each([
    null,
    "invalid database result",
    { rows: null },
    { rows: {} },
  ])("rejects malformed database result %p", async (databaseResult) => {
    mockExecute.mockResolvedValue(databaseResult);

    await expect(
      executeWithSchema(createMockDb(), z.object({ id: z.number() }), sql`SELECT 1`),
    ).rejects.toThrow("Unexpected database execute result shape");
  });

  it("rejects rows that do not match the schema", async () => {
    mockExecute.mockResolvedValue([{ id: "not-a-number" }]);

    await expect(
      executeWithSchema(createMockDb(), z.object({ id: z.number() }), sql`SELECT id FROM users`),
    ).rejects.toThrow(z.ZodError);
  });
});
