import { describe, expect, it } from "vitest";
import { jsonContent } from "./tool-utils.ts";

describe("jsonContent", () => {
  it("returns readable JSON text", () => {
    expect(jsonContent({ metric: "hrv", value: null })).toEqual({
      content: [{ type: "text", text: '{\n  "metric": "hrv",\n  "value": null\n}' }],
    });
  });

  it("rejects values that cannot be represented as JSON text", () => {
    expect(() => jsonContent(undefined)).toThrow("MCP tool result must be JSON-serializable");
  });
});
