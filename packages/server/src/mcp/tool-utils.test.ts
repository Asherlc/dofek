import { describe, expect, it } from "vitest";
import { jsonContent, mapWithConcurrency } from "./tool-utils.ts";

describe("jsonContent", () => {
  it("returns readable JSON text", () => {
    expect(jsonContent({ metric: "hrv", value: null })).toEqual({
      content: [{ type: "text", text: '{\n  "metric": "hrv",\n  "value": null\n}' }],
    });
  });

  it("rejects values that cannot be represented as JSON text", () => {
    expect(() => jsonContent(undefined)).toThrow("MCP tool results must be JSON-serializable");
  });
});

describe("mapWithConcurrency", () => {
  it("preserves input order while bounding concurrent work", async () => {
    let active = 0;
    let maximumActive = 0;
    const values = Array.from({ length: 17 }, (_, index) => index);

    const result = await mapWithConcurrency(values, 4, async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return value * 2;
    });

    expect(maximumActive).toBe(4);
    expect(result).toEqual(values.map((value) => value * 2));
  });
});
