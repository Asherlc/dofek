import { describe, expect, it } from "vitest";
import { z } from "zod";
import { dateWindowInput } from "./date-window.ts";

describe("dateWindowInput", () => {
  it("accepts valid endDate and days", () => {
    const result = dateWindowInput.parse({ endDate: "2026-03-23", days: 30 });
    expect(result).toEqual({ endDate: "2026-03-23", days: 30 });
  });

  it("defaults days to 30", () => {
    const result = dateWindowInput.parse({ endDate: "2026-03-23" });
    expect(result.days).toBe(30);
  });

  it("rejects invalid endDate format", () => {
    expect(() => dateWindowInput.parse({ endDate: "not-a-date" })).toThrow(z.ZodError);
    expect(() => dateWindowInput.parse({ endDate: "" })).toThrow(z.ZodError);
    expect(() => dateWindowInput.parse({ endDate: "2026/03/23" })).toThrow(z.ZodError);
  });

  it("defaults endDate to today when omitted", () => {
    const result = dateWindowInput.parse({ days: 7 });
    expect(result.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.days).toBe(7);
  });

  it("defaults both days and endDate when empty object", () => {
    const result = dateWindowInput.parse({});
    expect(result.days).toBe(30);
    expect(result.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
