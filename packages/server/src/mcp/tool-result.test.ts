import { describe, expect, it } from "vitest";
import { jsonToolResult } from "./tool-result.ts";

describe("jsonToolResult", () => {
  it("returns the exact value as structured content and readable JSON text", () => {
    const value = { range: { start_date: "2026-08-01", end_date: "2026-08-07" } };

    expect(jsonToolResult(value)).toEqual({
      content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
      structuredContent: value,
    });
  });
});
