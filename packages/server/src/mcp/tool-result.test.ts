import { describe, expect, it } from "vitest";
import { jsonToolError, jsonToolResult } from "./tool-result.ts";

describe("jsonToolResult", () => {
  it("returns an object-root structured result and readable JSON text", () => {
    const value = { range: { start_date: "2026-08-01", end_date: "2026-08-07" } };

    expect(jsonToolResult(value)).toEqual({
      content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
      structuredContent: { result: value },
    });
  });

  it("uses the JSON wire representation for structured content", () => {
    expect(jsonToolResult({ value: Number.NaN })).toEqual({
      content: [{ type: "text", text: '{\n  "value": null\n}' }],
      structuredContent: { result: { value: null } },
    });
  });

  it.each([
    ["undefined", undefined],
    ["BigInt", 1n],
    [
      "circular data",
      (() => {
        const value: { self?: unknown } = {};
        value.self = value;
        return value;
      })(),
    ],
  ])("rejects %s instead of emitting malformed text content", (_label, value) => {
    expect(() => jsonToolResult(value)).toThrow();
  });
});

describe("jsonToolError", () => {
  it("returns a safe JSON tool error with optional details", () => {
    expect(
      jsonToolError("CONFLICT", "The food record changed. Read it again.", {
        current_version: "target-2",
      }),
    ).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: {
                code: "CONFLICT",
                message: "The food record changed. Read it again.",
                details: { current_version: "target-2" },
              },
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    });
  });

  it("omits details when none are safe to return", () => {
    expect(jsonToolError("INTERNAL_ERROR", "The request could not be completed.")).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: {
                code: "INTERNAL_ERROR",
                message: "The request could not be completed.",
              },
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    });
  });
});
