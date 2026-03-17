import { describe, expect, it } from "vitest";
import { z } from "zod";
import { assertRows } from "./utils.ts";

const rowSchema = z.object({
  id: z.number(),
  name: z.string(),
});

describe("assertRows", () => {
  it("parses valid rows", () => {
    const data = [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ];
    const result = assertRows(data, rowSchema);
    expect(result).toEqual(data);
  });

  it("returns empty array for undefined input", () => {
    expect(assertRows(undefined, rowSchema)).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(assertRows([], rowSchema)).toEqual([]);
  });

  it("throws on invalid data", () => {
    const data = [{ id: "not-a-number", name: 123 }];
    expect(() => assertRows(data, rowSchema)).toThrow("Expected number");
  });

  it("throws when required fields are missing", () => {
    const data = [{}];
    expect(() => assertRows(data, rowSchema)).toThrow();
  });
});
