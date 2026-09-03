import { describe, expect, it } from "vitest";
import { jsonContent } from "./tool-utils.ts";

describe("jsonContent", () => {
  it("returns an object-root structured result and readable JSON text", () => {
    expect(jsonContent({ metric: "hrv", value: null })).toEqual({
      content: [{ type: "text", text: '{\n  "metric": "hrv",\n  "value": null\n}' }],
      structuredContent: { result: { metric: "hrv", value: null } },
    });
  });

  it("rejects values that cannot be represented as JSON text", () => {
    expect(() => jsonContent(undefined)).toThrow("MCP tool result must be JSON-serializable");
  });
});
