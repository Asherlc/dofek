import { describe, expect, it } from "vitest";
import { z } from "zod";
import { dateStringSchema, timestampStringSchema } from "./typed-sql.ts";

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

  it("rejects malformed YYYY-MM-DD strings", () => {
    const malformedDates = [
      "x2024-01-15",
      "2024-01-15x",
      "2-01-15",
      "text-01-15",
      "2024-1-15",
      "2024-aa-15",
      "2024-01-5",
      "2024-01-aa",
      "2024-01-15T00:00:00.000Z",
    ];

    for (const malformedDate of malformedDates) {
      expect(() => dateStringSchema.parse(malformedDate)).toThrow(z.ZodError);
    }
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

  it("passes through an unparseable timestamp string unchanged", () => {
    expect(timestampStringSchema.parse("not-a-timestamp")).toBe("not-a-timestamp");
  });

  it("rejects non-string non-date values", () => {
    expect(() => timestampStringSchema.parse(12345)).toThrow(z.ZodError);
    expect(() => timestampStringSchema.parse(null)).toThrow(z.ZodError);
  });
});
