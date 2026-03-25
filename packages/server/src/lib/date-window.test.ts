import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  dateWindowEnd,
  dateWindowInput,
  dateWindowStart,
  endDateSchema,
  timestampWindowStart,
} from "./date-window.ts";

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

describe("endDateSchema", () => {
  it("transforms undefined to today's date", () => {
    const result = endDateSchema.parse(undefined);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Verify it looks like a real date
    const parsed = new Date(result);
    expect(parsed.getTime()).not.toBeNaN();
  });

  it("passes through a valid YYYY-MM-DD date", () => {
    const result = endDateSchema.parse("2026-01-15");
    expect(result).toBe("2026-01-15");
  });

  it("rejects date with wrong separators", () => {
    expect(() => endDateSchema.parse("2026/01/15")).toThrow(z.ZodError);
  });

  it("rejects partial date", () => {
    expect(() => endDateSchema.parse("2026-01")).toThrow(z.ZodError);
  });

  it("rejects empty string", () => {
    expect(() => endDateSchema.parse("")).toThrow(z.ZodError);
  });

  it("rejects non-numeric segments", () => {
    expect(() => endDateSchema.parse("abcd-ef-gh")).toThrow(z.ZodError);
  });
});

describe("dateWindowStart", () => {
  it("returns a SQL object with queryChunks", () => {
    const result = dateWindowStart("2026-03-23", 30);
    expect(result.queryChunks).toBeDefined();
  });

  it("produces different SQL for different endDates", () => {
    const windowA = dateWindowStart("2026-03-23", 30);
    const windowB = dateWindowStart("2026-01-01", 30);
    expect(windowA).not.toEqual(windowB);
  });

  it("produces different SQL for different days values", () => {
    const windowA = dateWindowStart("2026-03-23", 30);
    const windowB = dateWindowStart("2026-03-23", 7);
    expect(windowA).not.toEqual(windowB);
  });

  it("embeds both endDate and days in query chunks", () => {
    const result = dateWindowStart("2026-03-23", 30);
    // The SQL template should contain both values
    const chunks = JSON.stringify(result.queryChunks);
    expect(chunks).toContain("2026-03-23");
    expect(chunks).toContain("30");
  });
});

describe("dateWindowEnd", () => {
  it("returns a SQL object with queryChunks", () => {
    const result = dateWindowEnd("2026-03-23");
    expect(result.queryChunks).toBeDefined();
  });

  it("produces different SQL for different endDates", () => {
    const windowA = dateWindowEnd("2026-03-23");
    const windowB = dateWindowEnd("2026-01-01");
    expect(windowA).not.toEqual(windowB);
  });

  it("embeds the endDate in query chunks", () => {
    const result = dateWindowEnd("2026-06-15");
    const chunks = JSON.stringify(result.queryChunks);
    expect(chunks).toContain("2026-06-15");
  });
});

describe("timestampWindowStart", () => {
  it("returns a SQL object with queryChunks", () => {
    const result = timestampWindowStart("2026-03-23", 7);
    expect(result.queryChunks).toBeDefined();
  });

  it("produces different SQL for different endDates", () => {
    const windowA = timestampWindowStart("2026-03-23", 7);
    const windowB = timestampWindowStart("2026-01-01", 7);
    expect(windowA).not.toEqual(windowB);
  });

  it("produces different SQL for different days values", () => {
    const windowA = timestampWindowStart("2026-03-23", 7);
    const windowB = timestampWindowStart("2026-03-23", 30);
    expect(windowA).not.toEqual(windowB);
  });

  it("embeds both endDate and days in query chunks", () => {
    const result = timestampWindowStart("2026-03-23", 14);
    const chunks = JSON.stringify(result.queryChunks);
    expect(chunks).toContain("2026-03-23");
    expect(chunks).toContain("14");
  });

  it("produces different result from dateWindowStart for same inputs", () => {
    const timestamp = timestampWindowStart("2026-03-23", 7);
    const dateStart = dateWindowStart("2026-03-23", 7);
    // They use different SQL casts (::timestamp vs just ::date - ::int)
    expect(timestamp).not.toEqual(dateStart);
  });
});
