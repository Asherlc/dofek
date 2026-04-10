import { SpanStatusCode } from "@opentelemetry/api";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { dateStringSchema, executeWithSchema, timestampStringSchema } from "./typed-sql.ts";

const mockExecute = vi.fn();

function createMockDb() {
  return { execute: mockExecute };
}

// Stub OTel tracer to capture span attributes
const mockSpan = {
  setAttribute: vi.fn(),
  setStatus: vi.fn(),
  end: vi.fn(),
};

vi.mock("@opentelemetry/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@opentelemetry/api")>();
  return {
    ...original,
    trace: {
      getTracer: () => ({
        startActiveSpan: (_name: string, callback: (span: typeof mockSpan) => unknown) =>
          callback(mockSpan),
      }),
    },
  };
});

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

  it("emits an OTel span with db.system, db.statement, and db.row_count", async () => {
    const schema = z.object({ id: z.number() });
    mockExecute.mockResolvedValue([{ id: 1 }, { id: 2 }]);

    const mockDb = createMockDb();
    await executeWithSchema(mockDb, schema, sql`SELECT id FROM users`);

    expect(mockSpan.setAttribute).toHaveBeenCalledWith("db.system", "postgresql");
    expect(mockSpan.setAttribute).toHaveBeenCalledWith(
      "db.statement",
      expect.stringContaining("SELECT id FROM users"),
    );
    expect(mockSpan.setAttribute).toHaveBeenCalledWith("db.row_count", 2);
    expect(mockSpan.end).toHaveBeenCalled();
    expect(mockSpan.setStatus).not.toHaveBeenCalled();
  });

  it("sets error status on span when query fails", async () => {
    const schema = z.object({ id: z.number() });
    mockExecute.mockRejectedValue(new Error("connection refused"));

    const mockDb = createMockDb();
    await expect(executeWithSchema(mockDb, schema, sql`SELECT 1`)).rejects.toThrow(
      "connection refused",
    );

    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: "Error: connection refused",
    });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it("includes nested SQL fragments in db.statement", async () => {
    const schema = z.object({ id: z.number() });
    mockExecute.mockResolvedValue([{ id: 1 }]);

    const inner = sql`up.id = ${"user-1"}`;
    const query = sql`SELECT * FROM t WHERE ${inner} AND x = ${"val"}`;

    const mockDb = createMockDb();
    await executeWithSchema(mockDb, schema, query);

    const statementCall = mockSpan.setAttribute.mock.calls.find(
      ([key]: [string]) => key === "db.statement",
    );
    const statement = String(statementCall?.[1]);
    // Should contain the full SQL including the nested fragment, not just $N
    expect(statement).toContain("up.id =");
    expect(statement).toContain("AND x =");
  });
});

describe("dateStringSchema", () => {
  it("passes through a YYYY-MM-DD string unchanged", () => {
    expect(dateStringSchema.parse("2024-01-15")).toBe("2024-01-15");
  });

  it("transforms a Date object to YYYY-MM-DD string", () => {
    expect(dateStringSchema.parse(new Date("2024-01-15T00:00:00.000Z"))).toBe("2024-01-15");
  });

  it("transforms a Date at end-of-year correctly", () => {
    expect(dateStringSchema.parse(new Date("2024-12-31T00:00:00.000Z"))).toBe("2024-12-31");
  });

  it("rejects non-string non-date values", () => {
    expect(() => dateStringSchema.parse(12345)).toThrow(z.ZodError);
    expect(() => dateStringSchema.parse(null)).toThrow(z.ZodError);
    expect(() => dateStringSchema.parse(undefined)).toThrow(z.ZodError);
  });

  it("rejects empty strings", () => {
    expect(() => dateStringSchema.parse("")).toThrow(z.ZodError);
  });

  it("rejects non-date strings", () => {
    expect(() => dateStringSchema.parse("not-a-date")).toThrow(z.ZodError);
    expect(() => dateStringSchema.parse("hello")).toThrow(z.ZodError);
  });
});

describe("timestampStringSchema", () => {
  it("passes through an ISO string unchanged", () => {
    expect(timestampStringSchema.parse("2024-01-15T10:30:00.000Z")).toBe(
      "2024-01-15T10:30:00.000Z",
    );
  });

  it("transforms a Date object to ISO string", () => {
    const date = new Date("2024-01-15T10:30:00.000Z");
    expect(timestampStringSchema.parse(date)).toBe("2024-01-15T10:30:00.000Z");
  });

  it("normalizes a postgres-format string to ISO 8601", () => {
    expect(timestampStringSchema.parse("2024-01-15 10:30:00+00")).toBe("2024-01-15T10:30:00.000Z");
  });

  it("normalizes a postgres-format string with microseconds to ISO 8601", () => {
    expect(timestampStringSchema.parse("2024-01-15 10:30:00.678162+00")).toBe(
      "2024-01-15T10:30:00.678Z",
    );
  });

  it("rejects non-string non-date values", () => {
    expect(() => timestampStringSchema.parse(12345)).toThrow(z.ZodError);
    expect(() => timestampStringSchema.parse(null)).toThrow(z.ZodError);
  });
});
